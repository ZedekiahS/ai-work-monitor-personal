import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
import "./styles.css";

const navigation = [
  { id: "overview", title: "总览" },
  { id: "live", title: "任务" },
  { id: "usage", title: "用量" },
  { id: "accounts", title: "账号与设备" },
  { id: "company", title: "公司空间" },
  { id: "settings", title: "设置" },
];
const validPage = (page: string) =>
  page === "history" || navigation.some((n) => n.id === page);
function App() {
  const [page, setPage] = useState(() =>
      validPage(location.hash.slice(1).split("?")[0])
        ? location.hash.slice(1).split("?")[0]
        : "overview",
    ),
    [revision, setRevision] = useState(0),
    [online, setOnline] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [notificationsOpen, setNotifications] = useState(false),
    [mobileNav, setMobileNav] = useState(false);
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
  const navigate = (id: string) => {
    setPage(id);
    location.hash = id;
    setMobileNav(false);
    document.getElementById("main")?.focus();
  };
  useEffect(() => {
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
  }, [refresh]);
  useEffect(() => {
    const fn = () => {
      const hash = location.hash.slice(1).split("?")[0];
      if (validPage(hash)) {
        setPage(hash);
        refresh();
      }
    };
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
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
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳至主要内容
      </a>
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <a
          href="#overview"
          className="brand"
          aria-label="AI Work Monitor 总览"
          onClick={() => navigate("overview")}
        >
          <span className="brand-symbol">
            <Icon name="live" size={27} />
          </span>
          <span>
            <strong>AI Work Monitor</strong>
            <small>个人工作监控</small>
          </span>
        </a>
        <nav aria-label="主导航">
          {navigation
            .filter(
              (n) =>
                n.id !== "settings" &&
                (n.id !== "company" || companyEnabled || page === "company"),
            )
            .map((n) => (
              <button
                key={n.id}
                aria-label={n.title}
                title={n.title}
                className={`nav-item ${page === n.id || (n.id === "live" && page === "history") ? "active" : ""}`}
                aria-current={
                  page === n.id || (n.id === "live" && page === "history")
                    ? "page"
                    : undefined
                }
                onClick={() => navigate(n.id)}
              >
                <Icon name={n.id} />
                <span>{n.title}</span>
              </button>
            ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            aria-label="设置"
            title="设置"
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <Icon name="settings" />
            <span>设置</span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-toggle"
              aria-label={mobileNav ? "收起导航" : "展开导航"}
              aria-expanded={mobileNav}
              onClick={() => setMobileNav((v) => !v)}
            >
              <Icon name="settings" />
            </button>
            <span>个人空间</span>
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
        <main id="main" tabIndex={-1}>
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
          {(page === "live" || page === "history") && (
            <div>
              <div className="task-tabs" role="tablist" aria-label="任务范围">
                <button
                  role="tab"
                  aria-selected={page === "live"}
                  onClick={() => navigate("live")}
                >
                  当前
                </button>
                <button
                  role="tab"
                  aria-selected={page === "history"}
                  onClick={() => navigate("history")}
                >
                  历史
                </button>
              </div>
              <SessionBrowser
                {...props}
                live={page === "live"}
                onSelect={openSession}
                accounts={account.data}
                sources={source.data?.sources || []}
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
          {page === "settings" && <SettingsPage {...props} />}
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
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
