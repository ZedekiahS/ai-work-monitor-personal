import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QuotaOrb, resetCountdown } from "../../ui/src/widget";
import { quotaWindow } from "../../ui/src/observation";
import "../../ui/src/widget.css";
import "./style.css";
declare global {
  interface Window {
    quotaDesktop: {
      widget: (action: string, value?: any) => Promise<any>;
      quota: (action: string) => Promise<any>;
    };
  }
}
const key = (q: any) => JSON.stringify([q.accountId, q.pool, q.window]);
function App() {
  const [prefs, setPrefs] = useState<any>(null),
    [data, setData] = useState<any>({ quotas: [], error: "", busy: true }),
    [message, setMessage] = useState(""),
    [now, setNow] = useState(Date.now());
  const command = async (action: string, value?: any) => {
    try {
      setPrefs(await window.quotaDesktop.widget(action, value));
    } catch {
      setMessage("设置未保存，请检查可用空间后重试。");
    }
  };
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () =>
      window.quotaDesktop
        .quota("state")
        .then((v) => {
          if (alive) {
            setData(v);
            setNow(Date.now());
          }
        })
        .catch(() => {
          if (alive) setMessage("暂时无法读取额度，请重新打开额度窗。");
        });
    const visibility = () => {
      clearInterval(timer);
      document.body.classList.toggle("widget-hidden", document.hidden);
      if (!document.hidden) {
        void refresh();
        timer = setInterval(refresh, 1000);
      }
    };
    window.quotaDesktop
      .widget("state")
      .then((v) => {
        if (alive) setPrefs(v);
      })
      .catch(() => setMessage("窗口设置读取失败，请重新打开。"));
    document.documentElement.classList.add("widget-mode");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  if (!prefs)
    return (
      <div className="quota-widget">
        <p>正在打开额度窗…</p>
      </div>
    );
  const selected = prefs.quotaKey
    ? data.quotas.find((q: any) => key(q) === prefs.quotaKey)
    : data.quotas[0];
  const stale = !data.observedAt || now - Date.parse(data.observedAt) > 180_000;
  const value = (q: any) =>
    !q || data.error || stale || (q.resetsAt && Date.parse(q.resetsAt) <= now)
      ? null
      : q.remainingPercent;
  const refresh = async () => {
    setMessage("");
    setData((v: any) => ({ ...v, busy: true }));
    try {
      setData(await window.quotaDesktop.quota("refresh"));
    } catch {
      setMessage("额度读取失败，请稍后重试。");
      setData((v: any) => ({ ...v, busy: false }));
    }
  };
  return (
    <div
      className={prefs.motion === false ? "no-motion" : ""}
      style={{ zoom: prefs.scale }}
    >
      {prefs.collapsed ? (
        <div className="widget-orb-stage">
          <QuotaOrb
            remaining={value(selected)}
            label={
              selected
                ? quotaWindow(selected.window).replace("窗口", "")
                : "剩余额度"
            }
            identity="Codex"
            tooltip={`${data.account || "当前登录"} · ${selected ? quotaWindow(selected.window) : "请选择额度窗口"}${data.error ? " · 读取失败" : stale ? " · 额度待更新" : ""}`}
            onExpand={() => command("collapsed", false)}
            onDrag={(action) => {
              void command(action);
            }}
            unknownLabel={data.busy ? "读取中" : "待更新"}
          />
          {(message || data.error) && (
            <button
              className="orb-alert"
              title={message || data.error}
              onClick={() => command("collapsed", false)}
            >
              !
            </button>
          )}
        </div>
      ) : (
        <div className="quota-widget">
          <header className="widget-titlebar">
            <strong>AI 额度窗</strong>
            <div className="widget-controls">
              <button
                aria-label="缩成水球"
                onClick={() => command("collapsed", true)}
              >
                ◉
              </button>
              <button aria-label="隐藏到托盘" onClick={() => command("hide")}>
                ×
              </button>
            </div>
          </header>
          <main className="widget-body">
            <p>{data.account || "当前 Codex 登录"}</p>
            {(data.error || message) && (
              <p role="alert" className="widget-warning">
                {message || data.error}
              </p>
            )}
            {!data.quotas.length && (
              <p className="widget-muted">
                {data.busy
                  ? "正在查询额度…"
                  : "请先在 Codex 登录。此窗口只读取当前登录账号的额度。"}
              </p>
            )}
            {prefs.quotaKey && !selected && data.quotas.length > 0 && (
              <p className="widget-warning">
                原关注额度已变化，请选择当前窗口。
              </p>
            )}
            <div className="widget-balances">
              {data.quotas.map((q: any) => (
                <button
                  key={key(q)}
                  className={`quota-balance ${selected === q ? "selected" : ""}`}
                  onClick={() => command("quotaKey", key(q))}
                >
                  <span className="quota-balance-top">
                    <span>
                      {quotaWindow(q.window)}
                      {data.quotas.some((other: any) => other.pool !== q.pool)
                        ? " · " + q.pool
                        : ""}
                    </span>
                    <strong>
                      {value(q) === null ? "未知" : value(q) + "%"}
                    </strong>
                  </span>
                  <span className="quota-meter">
                    <span style={{ width: (value(q) || 0) + "%" }} />
                  </span>
                  <span className="quota-balance-meta">
                    {value(q) === null
                      ? "额度待更新"
                      : resetCountdown(q.resetsAt, now)}
                  </span>
                </button>
              ))}
            </div>
            <p className="widget-muted">
              {data.observedAt
                ? `观察于 ${new Date(data.observedAt).toLocaleTimeString()}${stale ? " · 已过期" : ""}`
                : "尚未取得额度观察"}
            </p>
            <div className="quota-settings">
              <label>
                始终置顶
                <input
                  type="checkbox"
                  role="switch"
                  checked={prefs.pinned}
                  onChange={(e) => command("pinned", e.target.checked)}
                />
              </label>
              <label>
                动态效果
                <input
                  type="checkbox"
                  role="switch"
                  checked={prefs.motion !== false}
                  onChange={(e) => command("motion", e.target.checked)}
                />
              </label>
              <label>
                水球大小 <output>{Math.round(prefs.scale * 100)}%</output>
                <input
                  aria-label="水球大小"
                  type="range"
                  min="0.7"
                  max="1.5"
                  step="0.1"
                  value={prefs.scale}
                  onChange={(e) => command("scale", Number(e.target.value))}
                />
              </label>
            </div>
            <footer>
              <button
                onClick={refresh}
                disabled={data.busy || now < data.nextAllowedAt}
              >
                {data.busy
                  ? "查询中…"
                  : now < data.nextAllowedAt
                    ? "稍后可刷新"
                    : "刷新余额"}
              </button>
              <button onClick={() => command("collapsed", true)}>收起</button>
            </footer>
          </main>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
