using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace AIQuota {
    internal sealed class QuotaRpc : IQuotaRpc {
        internal const string Arguments = "-c mcp_servers={} -c features.hooks=false -s read-only -a never app-server";
        readonly Process child;
        readonly BlockingCollection<object> messages = new BlockingCollection<object>(32);
        readonly object writeGate = new object();
        readonly object disposeGate = new object();
        readonly IntPtr job;
        bool disposed;
        int id;
        internal int ProcessId { get { return child.Id; } }
        public static string FindCodex() {
            string explicitPath = Environment.GetEnvironmentVariable("CODEX_CLI_PATH");
            if (!string.IsNullOrEmpty(explicitPath)) {
                if (!Path.IsPathRooted(explicitPath) || !explicitPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(explicitPath)) throw new InvalidOperationException("codex-path-invalid");
                return explicitPath;
            }
            foreach (var path in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
                if (string.IsNullOrWhiteSpace(path)) continue;
                var file = Path.Combine(path.Trim('"'), "codex.exe");
                if (Path.IsPathRooted(file) && File.Exists(file)) return file;
            }
            var fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "OpenAI", "Codex", "bin", "codex.exe");
            if (File.Exists(fallback)) return fallback;
            throw new InvalidOperationException("codex-not-found");
        }
        public QuotaRpc(string exe) {
            child = new Process { StartInfo = new ProcessStartInfo(exe, Arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 } };
            job = Native.CreateJobObject(IntPtr.Zero, null);
            try {
                if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
                var info = new Native.ExtendedLimit(); info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE, only our probe tree.
                if (!Native.SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) throw new System.ComponentModel.Win32Exception();
                child.Start();
                if (!Native.AssignProcessToJobObject(job, child.Handle)) throw new System.ComponentModel.Win32Exception();
                Task.Run(() => Pump());
                Task.Run(() => { try { var buffer = new char[2048]; while (child.StandardError.Read(buffer, 0, buffer.Length) > 0) { } } catch (IOException) { } catch (ObjectDisposedException) { } });
            } catch { Dispose(); throw; }
        }
        void Pump() {
            try {
                var buffer = new char[4096]; var line = new StringBuilder(); int bytes = 0, read;
                while ((read = child.StandardOutput.Read(buffer, 0, buffer.Length)) > 0) {
                    for (int i = 0; i < read; i++) {
                        char c = buffer[i];
                        if (c != '\n') { line.Append(c); bytes += c <= 0x7f ? 1 : c <= 0x7ff ? 2 : 3; if (bytes > 2097152) throw new IOException("response-too-large"); continue; }
                        Dictionary<string, object> message = null;
                        try { message = Json.Object(Json.Serializer().DeserializeObject(line.ToString())); } catch (ArgumentException) { }
                        line.Clear(); bytes = 0;
                        if (message == null) continue;
                        if (Json.Get(message, "method") is string) {
                            if (message.ContainsKey("id")) Write(new { id = message["id"], error = new { code = -32601, message = "Read-only client" } });
                        } else if (!messages.TryAdd(message)) throw new IOException("response-queue-full");
                    }
                }
            } catch (IOException) { } catch (InvalidOperationException) { }
            finally { messages.CompleteAdding(); }
        }
        void Write(object value) { lock (writeGate) { if (disposed) throw new InvalidOperationException("probe-closed"); child.StandardInput.WriteLine(Json.Serializer().Serialize(value)); child.StandardInput.Flush(); } }
        public void Notify(string method, object args) { Write(new { method = method, @params = args }); }
        public object Request(string method, object args, int timeout) {
            int request = ++id; Write(new { id = request, method = method, @params = args });
            var clock = Stopwatch.StartNew(); object raw;
            while (clock.ElapsedMilliseconds < timeout) {
                if (!messages.TryTake(out raw, Math.Max(1, timeout - (int)clock.ElapsedMilliseconds))) throw new TimeoutException("probe-unavailable");
                var obj = Json.Object(raw); if (Json.Number(Json.Get(obj, "id")) != request) continue;
                if (Json.Get(obj, "error") != null || !obj.ContainsKey("result")) throw new InvalidOperationException("rpc-failed");
                return obj["result"];
            }
            throw new TimeoutException("probe-timeout");
        }
        public void Dispose() {
            lock (disposeGate) {
                if (disposed) return; disposed = true;
                if (job != IntPtr.Zero) Native.CloseHandle(job);
                try { if (!child.WaitForExit(2000)) { child.Kill(); child.WaitForExit(2000); } } catch (InvalidOperationException) { }
                child.Dispose();
            }
        }
        static class Native {
            [StructLayout(LayoutKind.Sequential)] internal struct BasicLimit { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinSet, MaxSet; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
            [StructLayout(LayoutKind.Sequential)] internal struct IO { public ulong a,b,c,d,e,f; }
            [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimit { public BasicLimit Basic; public IO IO; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
            [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
            [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
            [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
        }
    }
}
