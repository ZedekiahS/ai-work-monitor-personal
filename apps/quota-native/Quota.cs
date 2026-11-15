// Port of collector/quota-only.ts and quota-wire.ts. Original protocol adaptation:
// codex-usage-desktop, Copyright (c) 2026 vincent, MIT. See THIRD_PARTY_NOTICES.md.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace AIQuota {
    internal static class Json {
        public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 32 }; }
        public static Dictionary<string, object> Object(object value) { return value as Dictionary<string, object>; }
        public static object Get(object value, string key) { var obj = Object(value); object found; return obj != null && obj.TryGetValue(key, out found) ? found : null; }
        public static double? Number(object value) {
            if (!(value is int || value is long || value is double || value is decimal)) return null;
            double d = Convert.ToDouble(value); return double.IsNaN(d) || double.IsInfinity(d) ? (double?)null : d;
        }
        public static string Canonical(object value) {
            var obj = Object(value);
            if (obj != null) return "{" + string.Join(",", obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => Serializer().Serialize(p.Key) + ":" + Canonical(p.Value))) + "}";
            var arr = value as object[];
            return arr != null ? "[" + string.Join(",", arr.Select(Canonical)) + "]" : Serializer().Serialize(value);
        }
    }
    internal sealed class Quota {
        public string Key, Pool, Window;
        public double? Remaining;
        public DateTimeOffset? Reset;
        public bool Fresh(DateTimeOffset observed, DateTimeOffset now) { return now >= observed && now - observed < TimeSpan.FromMinutes(3) && (!Reset.HasValue || Reset.Value > now); }
        public string Label { get { double d; if (!double.TryParse(Window, out d)) return "未知周期"; if (d == 10080) return "每周额度"; if (d % 1440 == 0) return (d / 1440) + " 天额度"; return d % 60 == 0 ? (d / 60) + " 小时额度" : d + " 分钟额度"; } }
    }
    internal static class QuotaParser {
        public static List<Quota> Parse(object response) {
            var multi = Json.Object(Json.Get(response, "rateLimitsByLimitId"));
            var legacy = Json.Object(Json.Get(response, "rateLimits"));
            var pools = multi != null && multi.Count > 0 ? multi : legacy != null ? new Dictionary<string, object> { { Json.Get(legacy, "limitId") as string ?? "legacy", legacy } } : null;
            if (pools == null) throw new InvalidOperationException("limits-unavailable");
            var result = new List<Quota>();
            foreach (var p in pools.Take(100)) {
                var pool = Json.Object(p.Value); if (pool == null) continue;
                foreach (var slot in pool) {
                    var window = Json.Object(slot.Value);
                    if (slot.Key != "primary" && slot.Key != "secondary" && !(window != null && window.ContainsKey("usedPercent") && (window.ContainsKey("windowDurationMins") || window.ContainsKey("resetsAt")))) continue;
                    var duration = Json.Number(Json.Get(window, "windowDurationMins"));
                    var used = Json.Number(Json.Get(window, "usedPercent"));
                    var seconds = Json.Number(Json.Get(window, "resetsAt"));
                    DateTimeOffset? reset = null;
                    if (seconds.HasValue && seconds.Value >= -62135596800 && seconds.Value <= 253402300799) reset = new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero).AddSeconds(seconds.Value);
                    result.Add(new Quota { Key = p.Key + "/" + slot.Key, Pool = p.Key, Window = duration.HasValue && duration > 0 ? duration.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "unknown:" + slot.Key,
                        Remaining = used.HasValue ? Math.Max(0, Math.Min(100, 100 - used.Value)) : (double?)null, Reset = reset });
                }
            }
            if (result.Count == 0) throw new InvalidOperationException("windows-unavailable");
            return result;
        }
    }
    internal interface IQuotaRpc : IDisposable {
        object Request(string method, object args, int timeout);
        void Notify(string method, object args);
    }
    internal sealed class Snapshot {
        public List<Quota> Quotas = new List<Quota>();
        public string Account = "当前 Codex 登录", Error = "";
        public DateTimeOffset Observed;
    }
    internal sealed class BalanceReader : IDisposable {
        readonly object gate = new object();
        readonly Func<IQuotaRpc> factory;
        readonly Func<DateTimeOffset> clock;
        IQuotaRpc active;
        Task<Snapshot> flight;
        bool closed;
        int failures;
        public DateTimeOffset NextAllowed { get; private set; }
        public Snapshot Current { get; private set; }
        public BalanceReader(Func<IQuotaRpc> factory, Func<DateTimeOffset> clock) { this.factory = factory; this.clock = clock; Current = new Snapshot(); }
        public Task<Snapshot> Refresh() {
            lock (gate) {
                if (flight != null && !flight.IsCompleted) return flight;
                if (closed || clock() < NextAllowed) return Task.FromResult(Current);
                NextAllowed = clock().AddSeconds(60);
                flight = Task.Run(() => Read()); return flight;
            }
        }
        Snapshot Read() {
            IQuotaRpc rpc = null;
            try {
                lock (gate) { if (closed) return Current; active = rpc = factory(); }
                rpc.Request("initialize", new { clientInfo = new { name = "ai_quota_window", version = "0.2.0-native.1" } }, 20000);
                rpc.Notify("initialized", new { });
                var before = Json.Get(rpc.Request("account/read", new { refreshToken = false }, 5000), "account");
                if (Json.Object(before) == null) throw new InvalidOperationException("not-logged-in");
                var limits = rpc.Request("account/rateLimits/read", null, 5000);
                var after = Json.Get(rpc.Request("account/read", new { refreshToken = false }, 5000), "account");
                if (Json.Canonical(before) != Json.Canonical(after)) throw new InvalidOperationException("account-changed");
                var next = new Snapshot { Quotas = QuotaParser.Parse(limits), Observed = clock(), Account = Json.Get(before, "id") is string ? "当前 Codex 登录" : "当前登录 · 身份待确认" };
                lock (gate) { if (!closed) { Current = next; failures = 0; NextAllowed = clock().AddSeconds(60); } }
            } catch (Exception e) {
                // Boundary: never expose provider response, command paths or account credentials.
                if (!(e is InvalidOperationException || e is System.IO.IOException || e is System.ComponentModel.Win32Exception || e is TimeoutException || e is ArgumentException || e is System.Security.SecurityException || e is UnauthorizedAccessException)) throw;
                lock (gate) { if (!closed) { failures++; Current = new Snapshot { Error = "额度读取失败，请检查 Codex 登录与网络。" }; NextAllowed = clock().AddSeconds(Math.Min(900, 60 * Math.Pow(2, Math.Min(failures - 1, 4)))); } }
            } finally { if (rpc != null) rpc.Dispose(); lock (gate) active = null; }
            return Current;
        }
        public void Dispose() { lock (gate) { closed = true; if (active != null) active.Dispose(); } }
    }
}
