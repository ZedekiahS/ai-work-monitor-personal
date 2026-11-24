import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  date,
  mutate,
  useResource,
  type Accounts,
  type Source,
  type Scan,
} from "./api";
import { Button, Empty, ErrorBox, Icon } from "./components";
import { SessionBrowser, SessionDetail } from "./sessions";
import { AccountsPage, OverviewPage, SettingsPage, UsagePage } from "./pages";
import { EmployeeConnector } from "./sync";
import { EnvironmentPage } from "./environment";
import { UsageWidget } from "./widget";

const navigation = [
  { id: "overview", title: "总览" },
  { id: "live", title: "任务" },
  { id: "usage", title: "用量" },
  { id: "accounts", title: "账号与设备" },
  { id: "company", title: "公司空间" },
  { id: "settings", title: "监控设置" },
];
const toolLinks = [
  { id: "home", title: "我的工具", icon: "tools" },
  {
    id: "monitor",
    title: "AI Monitor",
    icon: "live",
    description: "查看 Codex 的任务、额度与用量。",
  },
  {
    id: "environment",
    title: "环境检查",
    icon: "environment",
    description: "检查本机 Codex 和会话采集来源。",
  },
] as const;
const isMonitor = (id: string) =>
  id === "history" || navigation.some((item) => item.id === id);
function readRoute(previousMonitor = "") {
  const hash = location.hash.slice(1);
  const id = hash.split("?")[0];
  if (isMonitor(id)) return { tool: "monitor", monitor: hash, hash };
  return {
    tool: id === "environment" ? id : "home",
    monitor: previousMonitor,
    hash,
  };
}
function navigate(hash: string) {
  location.hash = hash;
}
function taskScope(value: string | null) {
  return value === "live" || value === "history" ? value : undefined;
}
function MyTools({ monitor }: { monitor: string }) {
  return (
    <main className="tool-home" id="main" tabIndex={-1}>
      <h1>我的工具</h1>
      <div className="tool-cards">
        {toolLinks
          .filter((tool) => tool.id !== "home")
          .map((tool) => (
            <a
              key={tool.id}
              className={`tool-card tool-${tool.id}`}
              href={`#${tool.id === "monitor" ? monitor || "overview" : tool.id}`}
            >
              <span className="tool-card-icon">
                <Icon name={tool.icon} size={30} />
              </span>
              <h2>{tool.title}</h2>
              <p>{tool.description}</p>
              <Icon name="chevron" size={18} />
            </a>
          ))}
      </div>
    </main>
  );
}
function EnvironmentTool({ hash }: { hash: string }) {
  const source = useResource<{ sources: Source[] }>("/api/sources");
  const query = new URLSearchParams(hash.split("?")[1]);
  const from = taskScope(query.get("from"));
  const initialSourceId = query.get("source") || "";
  const openSourceSettings = (sourceId: string) => {
    const context = new URLSearchParams();
    if (from) context.set("from", from);
    if (sourceId) context.set("source", sourceId);
    // Back from settings should reopen the source chosen in Doctor.
    const doctorHash = context.size ? `environment?${context}` : "environment";
    if (hash !== doctorHash) {
      window.history.replaceState(window.history.state, "", `#${doctorHash}`);
    }
    context.set("section", "sources");
    navigate(`settings?${context}`);
  };
  return (
    <main id="main" tabIndex={-1}>
      {source.error && (
        <ErrorBox message={source.error} onRetry={source.refresh} />
      )}
      {!source.data && !source.error && <p role="status">正在读取采集来源…</p>}
      {source.data && (
        <EnvironmentPage
          sources={source.data.sources}
          initialSourceId={initialSourceId}
          onReturn={from ? () => navigate(from) : undefined}
          onSourceSettings={openSourceSettings}
        />
      )}
    </main>
  );
}
function Platform() {
  const [route, setRoute] = useState(() => readRoute());
  useEffect(() => {
    const change = () => setRoute((previous) => readRoute(previous.monitor));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useLayoutEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    const title =
      toolLinks.find((tool) => tool.id === route.tool)?.title || "我的工具";
    document.title =
      route.tool === "monitor"
        ? `${navigation.find((item) => item.id === route.monitor.split("?")[0])?.title || "任务"} · AI Monitor`
        : title;
  }, [route]);
  return (
    <div
      className={`app-shell platform-shell ${route.tool === "monitor" ? "with-monitor" : ""}`}
    >
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳至主要内容
      </a>
      <nav className="tool-rail" aria-label="工具导航">
        {toolLinks.map((tool) => (
          <a
            key={tool.id}
            href={`#${tool.id === "monitor" ? route.monitor || "overview" : tool.id}`}
            className="tool-link"
            aria-current={route.tool === tool.id ? "page" : undefined}
          >
            <Icon name={tool.icon} size={22} />
            <span>{tool.title}</span>
          </a>
        ))}
      </nav>
      {route.tool === "home" && (
        <div className="platform-content">
          <MyTools monitor={route.monitor} />
        </div>
      )}
      {route.tool === "environment" && (
        <div className="platform-content">
          <EnvironmentTool hash={route.hash} />
        </div>
      )}
      {route.monitor && (
        <Monitor route={route.monitor} visible={route.tool === "monitor"} />
      )}
    </div>
  );
}
function Monitor({ route, visible }: { route: string; visible: boolean }) {
  const [page, search] = route.split("?");
  const query = new URLSearchParams(search);
  const showSources = page === "settings" && query.get("section") === "sources";
  const returnToTasks = showSources ? taskScope(query.get("from")) : undefined;
  // Source settings is part of this task's round trip. Keep its list and page in memory.
  const tasks = taskScope(page) ?? returnToTasks;
  const [revision, setRevision] = useState(0),
    [online, setOnline] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [notificationsOpen, setNotifications] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const openSession = (id: string) => {
    if (!selected)
      selectionOrigin.current = document.activeElement as HTMLElement;
    setSelected(id);
  };
  const closeSession = () => {
    setSelected(null);
    requestAnimationFrame(() => selectionOrigin.current?.focus());
  };
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  const account = useResource<Accounts>("/api/accounts", revision),
    source = useResource<{ sources: Source[]; scan: Scan }>(
      "/api/sources",
      revision,
    ),
    notifications = useResource<{
      items: {
        id: string;
        title: string;
        body: string;
        createdAt: string;
        sessionId?: string;
      }[];
    }>("/api/notifications", revision);
  useEffect(() => {
    if (!visible) {
      setNotifications(false);
      setSelected(null);
      return;
    }
    refresh();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/events", { withCredentials: true });
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = () => {
      if (!debounce)
        debounce = setTimeout(() => {
          refresh();
          debounce = null;
        }, 500);
    };
    const fallback = setInterval(refresh, 5000);
    return () => {
      es.close();
      clearInterval(fallback);
      if (debounce) clearTimeout(debounce);
    };
  }, [refresh, visible]);
  const current = navigation.find(
    (n) => n.id === (page === "history" ? "live" : page),
  )!;
  const [companyEnabled, setCompanyEnabled] = useState(
    () =>
      localStorage.getItem("aiwm-company-visible") === "true" ||
      location.hash === "#company",
  );
  const enableCompany = () => {
    localStorage.setItem("aiwm-company-visible", "true");
    setCompanyEnabled(true);
    navigate("company");
  };
  const props = { revision, notify, onChanged: refresh };
  return (
    <div className="monitor-workspace" hidden={!visible}>
      <nav className="monitor-rail" aria-label="Monitor 导航">
        <strong>AI Monitor</strong>
        {navigation
          .filter(
            (n) => n.id !== "company" || companyEnabled || page === "company",
          )
          .map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              className="monitor-link"
              aria-current={current.id === n.id ? "page" : undefined}
            >
              <Icon name={n.id} size={18} />
              <span>{n.title}</span>
            </a>
          ))}
      </nav>
      <div className="platform-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>AI Monitor</span>
            <Icon name="chevron" size={12} />
            <strong>{current.title}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-only">
              <span className={`status-dot ${online ? "" : "offline"}`} />
              {online ? "本机监控已连接" : "正在重连本机监控"}
            </span>
            <button
              className="icon-button notification-button"
              aria-label={`通知 ${notifications.data?.items.length || 0} 条`}
              aria-expanded={notificationsOpen}
              onClick={() => setNotifications((v) => !v)}
            >
              <Icon name="bell" />
              {!!notifications.data?.items.length && <i />}
            </button>
            <span className="profile-avatar" aria-label="本地个人模式">
              我
            </span>
          </div>
        </header>
        {notificationsOpen && (
          <section className="notification-popover" aria-label="通知">
            <div className="between">
              <h2>待处理通知</h2>
              <button
                className="icon-button"
                aria-label="关闭通知"
                onClick={() => setNotifications(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
            {notifications.error && <ErrorBox message={notifications.error} />}{" "}
            {notifications.data?.items.length ? (
              notifications.data.items.map((n) => (
                <article key={n.id}>
                  <strong>{n.title}</strong>
                  <p>{n.body}</p>
                  <div className="between">
                    <small>{date(n.createdAt, true)}</small>
                    <div className="actions">
                      {n.sessionId && (
                        <Button
                          onClick={() => {
                            openSession(n.sessionId!);
                            setNotifications(false);
                          }}
                        >
                          查看
                        </Button>
                      )}
                      <Button
                        onClick={async () => {
                          try {
                            await mutate(
                              `/api/notifications/${encodeURIComponent(n.id)}/ack`,
                            );
                            refresh();
                          } catch (e) {
                            notify((e as Error).message, true);
                          }
                        }}
                      >
                        已知晓
                      </Button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <Empty icon="bell" title="没有待处理通知" />
            )}
          </section>
        )}
        <main id={visible ? "main" : undefined} tabIndex={-1}>
          {account.error && (
            <ErrorBox message={account.error} onRetry={account.refresh} />
          )}
          {source.error && (
            <ErrorBox message={source.error} onRetry={source.refresh} />
          )}
          {page === "accounts" && !account.data && !account.error && (
            <p role="status">正在读取账号与设备…</p>
          )}
          {page === "overview" && (
            <OverviewPage
              {...props}
              onSelect={openSession}
              onNavigate={navigate}
              accounts={account.data}
            />
          )}{" "}
          {tasks && (
            <div hidden={page !== tasks}>
              <div className="task-tabs" role="tablist" aria-label="任务范围">
                <button
                  role="tab"
                  aria-selected={tasks === "live"}
                  onClick={() => navigate("live")}
                >
                  当前
                </button>
                <button
                  role="tab"
                  aria-selected={tasks === "history"}
                  onClick={() => navigate("history")}
                >
                  历史
                </button>
              </div>
              <SessionBrowser
                {...props}
                live={tasks === "live"}
                visible={visible && page === tasks}
                onCheckSource={(id) =>
                  navigate(
                    `environment?${new URLSearchParams({ from: tasks, ...(id ? { source: id } : {}) })}`,
                  )
                }
                onSelect={openSession}
                accounts={account.data}
                sources={source.data?.sources}
              />
            </div>
          )}{" "}
          {page === "usage" && (
            <UsagePage revision={revision} accounts={account.data} />
          )}{" "}
          {page === "accounts" &&
            account.data &&
            source.data &&
            !account.error &&
            !source.error && (
              <AccountsPage
                {...props}
                accounts={account.data}
                sources={source.data?.sources || []}
                onEnableCompany={enableCompany}
              />
            )}{" "}
          {page === "company" && (
            <EmployeeConnector {...props} accounts={account.data} />
          )}{" "}
          {page === "settings" && (
            <SettingsPage
              {...props}
              showSources={visible && showSources}
              checkedSource={showSources ? query.get("source") ?? undefined : undefined}
              onReturnToTasks={returnToTasks ? () => navigate(returnToTasks) : undefined}
            />
          )}
        </main>
      </div>
      {selected && (
        <SessionDetail
          id={selected}
          revision={revision}
          onClose={closeSession}
          onSelect={openSession}
          notify={notify}
          onChanged={refresh}
        />
      )}{" "}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <Icon name={toast.error ? "warning" : "check"} size={18} />
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>界面遇到问题</h1>
        <p>请重新加载页面后再试。</p>
        <details>
          <summary>错误详情</summary>
          <pre>{this.state.error}</pre>
        </details>
        <Button onClick={() => location.reload()}>重新加载页面</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function App() {
  return (
    <ErrorBoundary>
      {new URLSearchParams(location.search).get("view") === "widget" ? (
        <UsageWidget />
      ) : (
        <Platform />
      )}
    </ErrorBoundary>
  );
}
