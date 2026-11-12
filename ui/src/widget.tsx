import { useEffect, useId, useRef, useState } from "react";
import {
  relativeTime,
  mutate,
  useResource,
  type Accounts,
  type Overview,
  type Quota,
} from "./api";
import { accountName, quotaRemaining, quotaWindow } from "./observation";
import { desktopBridge, type WidgetPreferences } from "./desktop";

const unbound = (q: Quota) =>
  q.unbound || !q.accountId || q.accountId.startsWith("unknown:");
export const widgetAccountKey = (q: Quota) =>
  JSON.stringify(
    unbound(q) ? ["source", q.sourceId] : ["account", q.accountId],
  );
export const widgetQuotaKey = (q: Quota) =>
  JSON.stringify([widgetAccountKey(q), q.pool, q.window]);
export function latestWidgetQuotas(quotas: Quota[]) {
  const seen = new Set<string>();
  return [...quotas]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .filter((q) => {
      const key = widgetQuotaKey(q);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) => (Number(a.window) || Infinity) - (Number(b.window) || Infinity),
    );
}
export function resetCountdown(at: string | null, now = Date.now()) {
  if (!at || !Number.isFinite(Date.parse(at))) return "重置时间未知";
  const minutes = Math.ceil((Date.parse(at) - now) / 60000);
  if (minutes <= 0) return "已到重置时间，待更新";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时后重置`;
}

/** A display of reported quota, never an estimate from local Token usage. */
export function QuotaOrb({
  remaining,
  label,
  onExpand,
  unknownLabel = "待更新",
  identity = "",
  tooltip,
  onDrag,
}: {
  remaining: number | null;
  label: string;
  onExpand: () => void;
  unknownLabel?: string;
  identity?: string;
  tooltip?: string;
  onDrag?: (action: "dragStart" | "dragMove" | "dragEnd") => void;
}) {
  const [holding, setHolding] = useState(false);
  const gesture = useRef<{
    id: number;
    held: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressClick = useRef(false);
  const dragCallback = useRef(onDrag);
  dragCallback.current = onDrag;
  const finish = () => {
    const current = gesture.current;
    if (!current) return;
    clearTimeout(current.timer);
    gesture.current = null;
    if (current.held) dragCallback.current?.("dragEnd");
    setHolding(false);
  };
  useEffect(() => {
    const cancel = () => {
      suppressClick.current = true;
      finish();
    };
    if (typeof window !== "undefined") window.addEventListener("blur", cancel);
    return () => {
      if (typeof window !== "undefined")
        window.removeEventListener("blur", cancel);
      const current = gesture.current;
      if (current) {
        clearTimeout(current.timer);
        if (current.held) dragCallback.current?.("dragEnd");
      }
    };
  }, []);
  const id = useId().replace(/:/g, "");
  const level =
    remaining === null ? null : Math.max(0, Math.min(100, remaining));
  return (
    <div
      className={`quota-orb ${holding ? "is-held" : ""} ${level === null ? "is-unknown" : ""} ${level !== null && level <= 15 ? "is-low" : ""}`}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <clipPath id={id + "clip"}>
            <circle cx="50" cy="50" r="46" />
          </clipPath>
          <linearGradient id={id + "water"} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--water-top)" />
            <stop offset="1" stopColor="var(--water-deep)" />
          </linearGradient>
          <radialGradient id={id + "glass"} cx="30%" cy="20%" r="85%">
            <stop offset="0" stopColor="#38574d" stopOpacity="0.9" />
            <stop offset="0.55" stopColor="#17372d" stopOpacity="0.94" />
            <stop offset="1" stopColor="#0d231c" stopOpacity="0.98" />
          </radialGradient>
        </defs>
        <circle
          className="orb-shell"
          cx="50"
          cy="50"
          r="46"
          fill={`url(#${id}glass)`}
        />
        {level !== null && level > 0 && (
          <g clipPath={`url(#${id}clip)`} data-water-percent={level}>
            <g
              className="orb-level"
              style={{
                transform: `translateY(${level === 100 ? -5 : 96 - 0.92 * level}px)`,
              }}
            >
              <path
                className="orb-wave-back"
                d="M-100 0 Q-75 -5 -50 0 T0 0 T50 0 T100 0 T150 0 T200 0 V110 H-100 Z"
                fill="var(--water-top)"
              />
              <path
                className="orb-wave-front"
                d="M-100 2 Q-75 7 -50 2 T0 2 T50 2 T100 2 T150 2 T200 2 V110 H-100 Z"
                fill={`url(#${id}water)`}
              />
              <circle
                className="orb-bubble orb-bubble-one"
                cx="28"
                cy="30"
                r="1.4"
              />
              <circle
                className="orb-bubble orb-bubble-two"
                cx="72"
                cy="44"
                r="1.8"
              />
            </g>
          </g>
        )}
        <path className="orb-glint" d="M20 29 Q29 14 47 12" />
        <path className="orb-glint-bottom" d="M62 88 Q78 83 85 69" />
        {level === null && (
          <circle className="orb-unknown-ring" cx="50" cy="50" r="39" />
        )}
      </svg>
      <button
        className="orb-open"
        title={(tooltip ? tooltip + "\n" : "") + "点击查看详情；长按拖动"}
        aria-label={`展开额度详情，${identity}，${label}，${level !== null ? level + "% 剩余" : "额度待更新"}`}
        onPointerDown={(e) => {
          if (e.button !== 0 || gesture.current || !onDrag) return;
          suppressClick.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
          const current = {
            id: e.pointerId,
            held: false,
            timer: setTimeout(() => {
              current.held = true;
              suppressClick.current = true;
              setHolding(true);
              dragCallback.current?.("dragStart");
            }, 350),
          };
          gesture.current = current;
        }}
        onPointerMove={(e) => {
          if (gesture.current?.id === e.pointerId && gesture.current.held)
            onDrag?.("dragMove");
        }}
        onPointerUp={(e) => {
          if (gesture.current?.id === e.pointerId) finish();
        }}
        onPointerCancel={() => {
          suppressClick.current = true;
          finish();
        }}
        onLostPointerCapture={finish}
        onClick={(e) => {
          if (e.detail === 0 || !suppressClick.current) onExpand();
          suppressClick.current = false;
        }}
      >
        <strong>
          {level !== null ? (
            <>
              {level}
              <small>%</small>
            </>
          ) : (
            "?"
          )}
        </strong>
        <span>{level !== null ? label : unknownLabel}</span>
        {identity && <span className="orb-identity">{identity}</span>}
      </button>
    </div>
  );
}
const defaults: WidgetPreferences = {
  visible: true,
  pinned: true,
  collapsed: true,
  scale: 1,
  quotaKey: "",
};
export function WidgetView({
  overview,
  accounts,
  preferences,
  error,
  busy,
  message,
  onCommand,
  onRefresh,
  now = Date.now(),
}: {
  overview: Overview | null;
  accounts: Accounts | null;
  preferences: WidgetPreferences;
  error: string;
  busy: boolean;
  message: string;
  onCommand: (action: string, value?: string | boolean | number) => void;
  onRefresh: () => void;
  now?: number;
}) {
  const quotas = latestWidgetQuotas(overview?.quotas ?? []);
  const accountsByKey = [
    ...new Map(quotas.map((q) => [widgetAccountKey(q), q])).values(),
  ];
  const selected = preferences.quotaKey
    ? quotas.find((q) => widgetQuotaKey(q) === preferences.quotaKey)
    : accountsByKey.length === 1
      ? quotas[0]
      : undefined;
  const group = selected
    ? quotas.filter((q) => widgetAccountKey(q) === widgetAccountKey(selected))
    : [];
  const label = (q: Quota) =>
    (unbound(q)
      ? "账号待确认"
      : accountName(
          q.accountId,
          accounts?.accounts.find((a) => a.id === q.accountId)?.label,
        )) +
    (unbound(q)
      ? " · " +
        (overview?.sources.find((s) => s.id === q.sourceId)?.label ??
          "本机来源") +
        " · " +
        relativeTime(q.observedAt)
      : "");
  const remaining = selected ? quotaRemaining(selected, !!error, now) : null;
  const orbLabel = selected
    ? quotaWindow(selected.window).replace("窗口", "")
    : "剩余额度";
  if (preferences.collapsed)
    return (
      <div className="widget-orb-stage" style={{ zoom: preferences.scale }}>
        <QuotaOrb
          remaining={remaining}
          label={orbLabel}
          identity={
            selected
              ? unbound(selected)
                ? "账号待确认"
                : accountName(
                    selected.accountId,
                    accounts?.accounts.find((a) => a.id === selected.accountId)
                      ?.label,
                  )
              : ""
          }
          tooltip={
            selected
              ? `${label(selected)} · ${selected.pool} · ${quotaWindow(selected.window)} · ${relativeTime(selected.observedAt)}更新`
              : "尚未选择可用额度"
          }
          onDrag={(action) => onCommand(action)}
          unknownLabel={!selected && quotas.length > 0 ? "选账号" : "待更新"}
          onExpand={() => onCommand("collapsed", false)}
        />
        {!!(message || error) && (
          <button
            className="orb-alert"
            aria-label={message || error}
            title={message || error}
            onClick={() => onCommand("collapsed", false)}
          >
            !
          </button>
        )}
      </div>
    );
  return (
    <div className="quota-widget" style={{ zoom: preferences.scale }}>
      <header className="widget-titlebar">
        <strong>额度水球</strong>
        <div className="widget-controls">
          <button
            role="switch"
            aria-label="始终置顶"
            aria-checked={preferences.pinned}
            onClick={() => onCommand("pinned", !preferences.pinned)}
          >
            置顶 {preferences.pinned ? "开" : "关"}
          </button>
          <button
            aria-label="缩成水球"
            onClick={() => onCommand("collapsed", true)}
          >
            ◉
          </button>
          <button aria-label="隐藏到托盘" onClick={() => onCommand("hide")}>
            ×
          </button>
        </div>
      </header>
      <main className="widget-body">
        {error && (
          <p role="alert" className="widget-warning">
            {error}
          </p>
        )}
        {!overview && !error && <p role="status">正在读取账号额度…</p>}
        <label className="widget-account-label">
          账号
          <select
            aria-label="关注的账号"
            value={selected ? widgetAccountKey(selected) : ""}
            onChange={(e) => {
              const q = quotas.find(
                (q) => widgetAccountKey(q) === e.target.value,
              );
              if (q) onCommand("quotaKey", widgetQuotaKey(q));
            }}
          >
            {!selected && (
              <option value="">
                {preferences.quotaKey
                  ? "已关注额度暂不可用"
                  : quotas.length
                    ? "请选择账号"
                    : "暂无额度观察"}
              </option>
            )}
            {accountsByKey.map((q) => (
              <option key={widgetAccountKey(q)} value={widgetAccountKey(q)}>
                {label(q)}
              </option>
            ))}
          </select>
        </label>
        {!quotas.length && overview && (
          <p className="widget-muted">
            还没有读到账号额度。请在 Codex 登录后刷新；无法获取时显示未知。
          </p>
        )}
        {preferences.quotaKey && !selected && (
          <p className="widget-warning">
            已关注额度暂不可用，请确认账号或重新选择。
          </p>
        )}
        <div className="widget-balances">
          {group.map((q) => {
            const value = quotaRemaining(q, !!error, now),
              focused =
                selected && widgetQuotaKey(selected) === widgetQuotaKey(q);
            return (
              <button
                key={widgetQuotaKey(q)}
                className={`quota-balance ${focused ? "selected" : ""}`}
                aria-pressed={!!focused}
                onClick={() => onCommand("quotaKey", widgetQuotaKey(q))}
              >
                <span className="quota-balance-top">
                  <span>
                    {quotaWindow(q.window)}
                    {group.some((other) => other.pool !== q.pool)
                      ? " · " + q.pool
                      : ""}
                  </span>
                  <strong>
                    {value === null ? "未知" : `${value}%`}
                    <small>{value !== null ? " 剩余" : ""}</small>
                  </strong>
                </span>
                <span
                  className={`quota-meter ${value === null ? "unknown" : ""}`}
                >
                  <span
                    style={{ width: value === null ? "0%" : value + "%" }}
                  />
                </span>
                <span className="quota-balance-meta">
                  {value === null ? "待更新 · " : ""}
                  {q.freshness === "fresh" && !error
                    ? resetCountdown(q.resetsAt, now)
                    : "重置时间待更新"}
                </span>
              </button>
            );
          })}
        </div>
        {selected && (
          <p className="widget-muted">
            {unbound(selected) ? "账号待确认 · " : ""}
            {relativeTime(selected.observedAt)}更新 · 重置时间来自额度记录
          </p>
        )}
        <div className="widget-size">
          <span>水球大小</span>
          <button
            aria-label="缩小水球"
            disabled={preferences.scale <= 0.7}
            onClick={() =>
              onCommand(
                "scale",
                Math.max(0.7, Math.round((preferences.scale - 0.1) * 10) / 10),
              )
            }
          >
            −
          </button>
          <span>{Math.round(preferences.scale * 100)}%</span>
          <button
            aria-label="放大水球"
            disabled={preferences.scale >= 1.5}
            onClick={() =>
              onCommand(
                "scale",
                Math.min(1.5, Math.round((preferences.scale + 0.1) * 10) / 10),
              )
            }
          >
            ＋
          </button>
        </div>
        <p className="widget-muted">选中一个窗口，水球显示它的剩余额度。</p>
        <footer>
          <button disabled={busy} onClick={onRefresh}>
            {busy ? "查询中…" : "刷新额度"}
          </button>
          <button onClick={() => onCommand("monitor", "accounts")}>
            打开监控台 ↗
          </button>
        </footer>
        {message && (
          <p role="status" className="widget-warning">
            {message}
          </p>
        )}
      </main>
    </div>
  );
}
export function UsageWidget() {
  const [preferences, setPreferences] = useState(defaults),
    [revision, setRevision] = useState(0),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  const overview = useResource<Overview>("/api/overview", revision),
    accounts = useResource<Accounts>("/api/accounts", revision);
  useEffect(() => {
    document.body.classList.add("widget-mode");
    document.documentElement.classList.add("widget-mode");
    document.title = "AI 额度水球";
    const bridge = desktopBridge();
    bridge
      ?.widget("state")
      .then(setPreferences)
      .catch(() => setMessage("浮窗设置读取失败，请重新打开。"));
    const unsubscribe = bridge?.onWidgetError(setMessage);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      setRevision((v) => v + 1);
      setNow(Date.now());
    };
    let events: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      events?.close();
      events = null;
      if (timer) clearInterval(timer);
      timer = null;
      if (debounce) clearTimeout(debounce);
      debounce = null;
    };
    const visibility = () => {
      document.body.classList.toggle("widget-hidden", document.hidden);
      stop();
      if (document.hidden) return;
      refresh();
      events = new EventSource("/api/events", { withCredentials: true });
      events.onmessage = () => {
        if (!document.hidden && !debounce)
          debounce = setTimeout(() => {
            debounce = null;
            if (!document.hidden) refresh();
          }, 500);
      };
      timer = setInterval(refresh, 5000);
    };
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      stop();
      unsubscribe?.();
      document.body.classList.remove("widget-mode");
      document.documentElement.classList.remove("widget-mode");
      document.removeEventListener("visibilitychange", visibility);
      document.body.classList.remove("widget-hidden");
    };
  }, []);
  const command = async (action: string, value?: string | boolean | number) => {
    try {
      const bridge = desktopBridge();
      if (bridge) setPreferences(await bridge.widget(action, value));
      else if (action === "monitor") location.href = "/#" + value;
      else if (["quotaKey", "collapsed", "pinned", "scale"].includes(action))
        setPreferences((p) => ({ ...p, [action]: value }));
      else setMessage("请从桌面程序操作浮窗。");
    } catch {
      setMessage("浮窗设置未保存，请重试并检查可用空间。");
    }
  };
  const refreshQuota = async () => {
    setBusy(true);
    setMessage("");
    try {
      await mutate("/api/quota/refresh");
      setRevision((v) => v + 1);
      setMessage("额度已更新");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <WidgetView
      overview={overview.data}
      accounts={accounts.data}
      preferences={preferences}
      error={overview.error}
      busy={busy}
      message={message || accounts.error}
      onCommand={command}
      onRefresh={refreshQuota}
      now={now}
    />
  );
}
