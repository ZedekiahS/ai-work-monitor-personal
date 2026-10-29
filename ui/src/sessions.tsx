import { collectExport, exportCsv } from "./exports";
import React from "react";
import { useEffect, useMemo, useState, useRef } from "react";
import {
  forestFor,
  sessionForView,
  historyForDetail,
  accountName,
} from "./observation";
import {
  api,
  relativeTime,
  compact,
  date,
  download,
  mutate,
  number,
  shortId,
  stateNames,
  useResource,
  type Accounts,
  type Detail,
  type List,
  type Overview,
  type Session,
  type Source,
} from "./api";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  Empty,
  ErrorBox,
  Icon,
  JsonPreview,
  Loading,
  Panel,
  StateBadge,
} from "./components";

export type Filters = {
  q: string;
  status: string;
  model: string;
  project: string;
  account: string;
  source: string;
  from: string;
  to: string;
};
export const emptyFilters: Filters = {
  q: "",
  status: "",
  model: "",
  project: "",
  account: "",
  source: "",
  from: "",
  to: "",
};
export function filterQuery(filters: Filters) {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v)
      .map(([k, v]) => [
        k,
        ["from", "to"].includes(k) ? new Date(v).toISOString() : v,
      ]),
  ).toString();
}
export function SessionFilters({
  filters,
  onChange,
  accounts,
  sources,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  accounts: Accounts | null;
  sources: Source[];
}) {
  const [expanded, setExpanded] = useState(false);
  const set = (key: keyof Filters, value: string) =>
    onChange({ ...filters, [key]: value });
  return (
    <div className="filters">
      <div className="filter-line">
        <label className="search-input">
          <Icon name="search" size={18} />
          <input
            aria-label="搜索会话标题、ID 或项目"
            placeholder="搜索会话、项目或 ID…"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </label>
        <select
          aria-label="状态筛选"
          value={filters.status}
          onChange={(e) => set("status", e.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(stateNames).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <Button
          onClick={() => setExpanded((v) => !v)}
          variant={expanded ? "selected" : ""}
        >
          更多筛选{" "}
          {Object.values(filters).filter(Boolean).length > 0 && (
            <span className="count">
              {Object.values(filters).filter(Boolean).length}
            </span>
          )}
        </Button>
        {Object.values(filters).some(Boolean) && (
          <Button onClick={() => onChange(emptyFilters)}>清除</Button>
        )}
      </div>
      {expanded && (
        <div className="filter-extra">
          <label>
            账号
            <select
              value={filters.account}
              onChange={(e) => set("account", e.target.value)}
            >
              <option value="">全部账号</option>
              <option value="unknown">未确认归属</option>
              {accounts?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            采集来源
            <select
              value={filters.source}
              onChange={(e) => set("source", e.target.value)}
            >
              <option value="">全部设备 / 来源</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            项目
            <input
              value={filters.project}
              onChange={(e) => set("project", e.target.value)}
              placeholder="项目标识 / 别名"
            />
          </label>
          <label>
            模型
            <input
              value={filters.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="模型名称"
            />
          </label>
          <label>
            开始时间
            <input
              type="datetime-local"
              value={filters.from}
              onChange={(e) => set("from", e.target.value)}
            />
          </label>
          <label>
            结束时间
            <input
              type="datetime-local"
              value={filters.to}
              onChange={(e) => set("to", e.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function SessionTable({
  sessions,
  onSelect,
  accounts,
}: {
  sessions: Session[];
  onSelect: (id: string) => void;
  accounts?: Accounts | null;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>会话 / 任务</th>
            <th>状态</th>
            <th>模型</th>
            <th>Token 用量</th>
            <th>最近活动</th>
            <th aria-label="查看详情" />
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <button className="session-name" onClick={() => onSelect(s.id)}>
                  {s.pinned && <Icon name="pin" size={13} />}
                  <span>{s.title || `会话 ${shortId(s.id)}`}</span>
                </button>
                <div className="subline">
                  {s.parentId ? (
                    <span>
                      {s.relation === "fork" ? "分支" : "子 Agent"} ·{" "}
                    </span>
                  ) : null}
                  {s.metadataOnly ? "" : ""}
                  {s.project || "项目未识别"} ·{" "}
                  {accounts?.accounts.find((a) => a.id === s.accountId)
                    ?.label || accountName(s.accountId)}
                </div>
              </td>
              <td>
                <StateBadge session={s} />
                {s.state === "unknown" &&
                  s.lastState &&
                  s.lastState !== "unknown" && (
                    <div className="subline">
                      最后观察：{stateNames[s.lastState] || s.lastState}
                    </div>
                  )}
              </td>
              <td>
                <span className="mono small">{s.model || "未提供"}</span>
              </td>
              <td
                className="numeric"
                title={
                  s.metadataOnly || s.usageAvailable === false
                    ? "缺少可重建用量日志，Token 未知"
                    : number(s.totalTokens)
                }
              >
                {s.metadataOnly || s.usageAvailable === false
                  ? "未知"
                  : compact(s.totalTokens)}
                {s.usageUncertain && !s.metadataOnly && (
                  <small className="amber"> 至少</small>
                )}
              </td>
              <td className="small muted">{date(s.updatedAt, true)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`查看 ${s.title || s.id}`}
                  onClick={() => onSelect(s.id)}
                >
                  <Icon name="chevron" size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentTree({
  sessions,
  onSelect,
  selected,
  compactView = false,
}: {
  compactView?: boolean;
  sessions: Session[];
  onSelect: (id: string) => void;
  selected?: string | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        compactView
          ? sessions
              .filter((s) =>
                sessions.some(
                  (c) => c.parentId === s.id && c.relation !== "fork",
                ),
              )
              .map((s) => s.id)
          : [],
      ),
  );
  const { roots, children } = forestFor(sessions);
  const visited = new Set<string>();
  const node = (s: Session, depth: number): React.ReactNode => {
    if (visited.has(s.id)) return null;
    visited.add(s.id);
    const child = children.get(s.id) || [];
    return (
      <div className="tree-branch" key={s.id}>
        <div
          className={`tree-node ${selected === s.id ? "active" : ""}`}
          style={{ paddingLeft: `${Math.min(depth, 12) * 20 + 12}px` }}
        >
          <button
            className="tree-toggle"
            disabled={!child.length}
            aria-label={collapsed.has(s.id) ? "展开后代" : "收起后代"}
            aria-expanded={!collapsed.has(s.id)}
            onClick={() =>
              setCollapsed((old) => {
                const n = new Set(old);
                n.has(s.id) ? n.delete(s.id) : n.add(s.id);
                return n;
              })
            }
          >
            {child.length ? (
              <span className={collapsed.has(s.id) ? "" : "rotate"}>
                <Icon name="chevron" size={14} />
              </span>
            ) : (
              <span className="tree-dot" />
            )}
          </button>
          <button className="tree-info" onClick={() => onSelect(s.id)}>
            <span className="between">
              <strong title={s.title}>
                {s.title || `Agent ${shortId(s.id)}`}
              </strong>
              <StateBadge session={s} />
            </span>
            <span className="subline">
              {s.relation === "fork"
                ? "分支 · "
                : depth
                  ? "子任务 · "
                  : s.parentId
                    ? "子任务 · "
                    : "主任务 · "}
              {compactView ? (
                `最近活动 ${relativeTime(s.updatedAt)}`
              ) : (
                <>
                  {s.model || "模型未知"} ·{" "}
                  {s.metadataOnly || s.usageAvailable === false
                    ? "Token 未知"
                    : `${compact(s.totalTokens)} Token`}
                  {s.usageUncertain ? "（至少）" : ""} ·{" "}
                  {date(s.updatedAt, true)}
                </>
              )}
            </span>
          </button>
        </div>
        {!collapsed.has(s.id) && child.map((c) => node(c, depth + 1))}
      </div>
    );
  };
  return <div className="agent-tree">{roots.map((s) => node(s, 0))}</div>;
}

export function SessionBrowser({
  live,
  revision,
  onSelect,
  accounts,
  sources,
  notify,
}: {
  live: boolean;
  revision: number;
  onSelect: (id: string) => void;
  accounts: Accounts | null;
  sources: Source[];
  notify: (text: string, error?: boolean) => void;
}) {
  const [filters, setFilters] = useState<Filters>(emptyFilters),
    [page, setPage] = useState(1),
    [paused, setPaused] = useState(false),
    [frozenRevision, setFrozen] = useState(revision),
    [activeOnly, setActiveOnly] = useState(false);
  const query = filterQuery(filters);
  useEffect(() => {
    if (!paused) setFrozen(revision);
  }, [revision, paused]);
  useEffect(() => setPage(1), [query, live]);
  const history = useResource<List>(
    live ? null : `/api/sessions?${query}&page=${page}&pageSize=30`,
    live ? frozenRevision : revision,
  );
  const current = useResource<Overview>(
    live ? "/api/overview" : null,
    frozenRevision,
  );
  const matches = (s: Session) =>
    (!filters.q ||
      `${s.title} ${s.id} ${s.project}`
        .toLowerCase()
        .includes(filters.q.toLowerCase())) &&
    (!filters.status || s.state === filters.status) &&
    (!filters.model || s.model.includes(filters.model)) &&
    (!filters.project || s.project.includes(filters.project)) &&
    (!filters.source || s.sourceId === filters.source) &&
    (!filters.account ||
      (filters.account === "unknown"
        ? !s.accountId || s.accountId.startsWith("unknown:")
        : s.accountId === filters.account)) &&
    (!filters.from || s.startedAt >= new Date(filters.from).toISOString()) &&
    (!filters.to || s.startedAt <= new Date(filters.to).toISOString());
  const currentItems = current.data?.activity?.items.filter(matches) || [];
  const result = live
    ? {
        ...current,
        data: current.data
          ? {
              items: currentItems,
              total: currentItems.length,
              page: 1,
              pageSize: 1000,
            }
          : null,
      }
    : history;
  const sessions = (result.data?.items || []).map((s) =>
    sessionForView(s, !!result.error),
  );
  const shown = activeOnly
    ? sessions.filter((s) =>
        ["running", "waiting_user", "waiting_approval"].includes(s.state),
      )
    : sessions;
  const [exporting, setExporting] = useState(false);
  const exportFile = async (format: "json" | "csv") => {
    setExporting(true);
    try {
      const out = await collectExport<Record<string, unknown>>((cursor) =>
        api(
          `/api/export?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
      download(
        `ai-work-monitor-${new Date().toISOString().slice(0, 10)}.${format}`,
        format === "csv" ? exportCsv(out.items) : JSON.stringify(out, null, 2),
        format === "csv" ? "text/csv;charset=utf-8" : "application/json",
      );
      notify(
        `完整导出 ${number(out.count)} 条元数据；范围截止 ${date(out.snapshotAt)}，不含期间新增`,
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{live ? "当前任务" : "任务历史"}</h1>
        </div>
        <div className="actions">
          {live ? (
            <Button
              icon={paused ? "play" : "pause"}
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? "恢复视图更新" : "暂停视图更新"}
            </Button>
          ) : (
            <>
              <Button
                icon="download"
                disabled={exporting}
                onClick={() => exportFile("csv")}
              >
                CSV · 全部匹配
              </Button>
              <Button disabled={exporting} onClick={() => exportFile("json")}>
                {exporting ? "正在完整导出…" : "JSON · 全部匹配"}
              </Button>
            </>
          )}
          <Button
            icon="refresh"
            aria-label="刷新会话列表"
            onClick={result.refresh}
          />
        </div>
      </div>
      {live && paused && (
        <div className="notice">页面更新已暂停，后台继续采集。</div>
      )}
      {live && current.data?.activity?.truncated && (
        <div className="notice warning">
          当前活动超过 1000 节点显示范围，请在历史页筛选并分页检查。
        </div>
      )}
      <Panel>
        <SessionFilters
          filters={filters}
          onChange={setFilters}
          accounts={accounts}
          sources={sources}
        />
        <div className="list-summary">
          <span>
            {result.data
              ? `共 ${number(result.data.total)} 个匹配会话`
              : "正在查询"}
          </span>
          {live && (
            <label className="check">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />
              只看运行 / 待处理
            </label>
          )}
        </div>
        {result.error && (
          <ErrorBox message={result.error} onRetry={result.refresh} />
        )}{" "}
        {!result.data && result.loading ? (
          <Loading />
        ) : shown.length ? (
          live ? (
            <AgentTree sessions={shown} onSelect={onSelect} />
          ) : (
            <SessionTable
              sessions={shown}
              onSelect={onSelect}
              accounts={accounts}
            />
          )
        ) : (
          <Empty
            title={
              Object.values(filters).some(Boolean) || activeOnly
                ? "没有匹配的会话"
                : "尚未采集到会话"
            }
            description={
              activeOnly
                ? "暂无运行中或等待处理的任务。"
                : "试试其他筛选条件，或在设置中检查采集来源。"
            }
          />
        )}
        {!live && (
          <div className="pagination">
            <span>
              第 {page} 页
              {result.data
                ? ` / ${Math.max(1, Math.ceil(result.data.total / result.data.pageSize))} 页`
                : ""}
            </span>
            <div className="actions">
              <Button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </Button>
              <Button
                disabled={
                  !result.data ||
                  page * result.data.pageSize >= result.data.total
                }
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}

export function SessionDetail({
  id,
  revision,
  onClose,
  onSelect,
  notify,
  onChanged,
}: {
  id: string;
  revision: number;
  onClose: () => void;
  onSelect: (id: string) => void;
  notify: (text: string, error?: boolean) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("events"),
    [notes, setNotes] = useState(""),
    [pinned, setPinned] = useState(false),
    [confirm, setConfirm] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [replay, setReplay] = useState<number | null>(null);
  const result = useResource<Detail>(
    `/api/sessions/${encodeURIComponent(id)}${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`,
    revision,
  );
  const d = result.data
    ? {
        ...result.data,
        session: sessionForView(result.data.session, !!result.error),
        agents: result.data.agents.map((s) =>
          sessionForView(s, !!result.error),
        ),
      }
    : null;
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || document.querySelector("dialog[open]")) return;
      const nodes = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]",
        ) || []),
      ].filter((n) => n.offsetParent !== null && n.tabIndex >= 0);
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    setTab("events");
    setCursor(null);
    setReplay(null);
  }, [id]);
  useEffect(() => {
    if (d) {
      setNotes(d.notes ?? d.session.notes ?? "");
      setPinned(d.pinned ?? d.session.pinned ?? false);
    }
  }, [id, d?.notes, d?.pinned]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirm) onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose, confirm]);
  const save = async () => {
    try {
      await mutate(`/api/sessions/${encodeURIComponent(id)}/note`, {
        notes,
        pinned,
      });
      notify("备注与关注已保存");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const remove = async () => {
    try {
      await mutate(
        `/api/sessions/${encodeURIComponent(id)}`,
        undefined,
        "DELETE",
      );
      notify("监控记录已删除");
      onChanged();
      onClose();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const events = useMemo(
    () =>
      [...(d?.events || [])].sort((a, b) =>
        a.occurredAt.localeCompare(b.occurredAt),
      ),
    [d?.events],
  );
  const visibleEvents = replay === null ? events : events.slice(0, replay + 1);
  const { available: historyAvailable, nextBefore } = historyForDetail(d);
  const safeJump =
    d?.session.jumpUrl &&
    /^codex:\/\/threads\/[a-zA-Z0-9_-]+(?:\?[^\s]*)?$/.test(d.session.jumpUrl)
      ? d.session.jumpUrl
      : null;
  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        ref={dialogRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="会话详情"
      >
        <div className="drawer-heading">
          <div>
            <h2>{d?.session.title || `会话 ${shortId(id)}`}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            autoFocus
            aria-label="关闭详情"
          >
            <Icon name="close" />
          </button>
        </div>
        {result.error && (
          <ErrorBox message={result.error} onRetry={result.refresh} />
        )}{" "}
        {!d ? (
          <Loading />
        ) : (
          <>
            <div className="detail-summary">
              <div className="between">
                <StateBadge session={d.session} />
                <span className="small muted">
                  最近活动 {date(d.session.updatedAt, true)}
                </span>
              </div>
              {d.session.state === "unknown" && (
                <p className="notice compact">
                  当前状态待确认。最后观察为「
                  {stateNames[d.session.lastState] ||
                    d.session.lastState ||
                    "未知"}
                  」。
                </p>
              )}
              {d.session.metadataOnly && (
                <p className="notice compact">
                  当前记录未提供 Token 用量。
                  {historyAvailable
                    ? "可在下方查看历史内容。"
                    : "没有可读取的历史内容。"}
                </p>
              )}
              <details className="task-information">
                <summary>任务信息</summary>
                <dl className="detail-meta">
                  <div>
                    <dt>会话 ID</dt>
                    <dd className="mono">{id}</dd>
                  </div>
                  <div>
                    <dt>轮次</dt>
                    <dd className="mono">{d.session.turnId || "未提供"}</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>{d.session.model || "未提供"}</dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd className="mono">{shortId(d.session.sourceId)}</dd>
                  </div>
                  <div>
                    <dt>账号归属</dt>
                    <dd>{accountName(d.session.accountId)}</dd>
                  </div>
                  <div>
                    <dt>开始时间</dt>
                    <dd>{date(d.session.startedAt, true)}</dd>
                  </div>
                  <div>
                    <dt>父节点</dt>
                    <dd>
                      {d.session.parentId ? (
                        <button
                          className="text-button"
                          onClick={() => onSelect(d.session.parentId!)}
                        >
                          {shortId(d.session.parentId)} ·{" "}
                          {d.session.relation === "fork" ? "Fork" : "Spawn"}
                        </button>
                      ) : (
                        "未记录父节点"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>状态依据</dt>
                    <dd>
                      {d.session.evidence === "confirmed"
                        ? "明确事件"
                        : d.session.evidence === "inferred"
                          ? "间接推断"
                          : "证据不足"}
                    </dd>
                  </div>
                </dl>
              </details>
              <div className="actions">
                <CopyButton value={id} />
                {safeJump ? (
                  <a className="button" href={safeJump}>
                    <Icon name="arrow" size={16} />
                    打开原会话
                  </a>
                ) : (
                  <span className="small muted">
                    可复制会话 ID，在 Codex 中查找
                  </span>
                )}
              </div>
            </div>
            <div className="tabs" role="tablist">
              {[
                ["events", "事件与回放"],
                ["agents", "Agent 关系"],
                ["usage", "用量"],
                ["notes", "备注与管理"],
              ].map(([key, label]) => (
                <button
                  role="tab"
                  aria-selected={tab === key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                  key={key}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="drawer-body">
              {tab === "events" &&
                (!historyAvailable ? (
                  <Empty
                    title="正文回放不可用"
                    description="该记录未提供历史内容。"
                  />
                ) : (
                  <>
                    <div className="between section-gap">
                      <span className="small muted">
                        已加载 {number(events.length)} 条记录
                      </span>
                      <Button
                        icon={replay === null ? "history" : "close"}
                        onClick={() => setReplay(replay === null ? 0 : null)}
                      >
                        {replay === null ? "历史回放" : "退出回放"}
                      </Button>
                    </div>
                    {replay !== null && (
                      <div className="replay-controls">
                        <strong>历史回放 · 不代表当前状态</strong>
                        <input
                          type="range"
                          aria-label="回放事件位置"
                          min={0}
                          max={Math.max(events.length - 1, 0)}
                          value={replay}
                          onChange={(e) => setReplay(Number(e.target.value))}
                        />
                        <span>
                          {events[replay]
                            ? date(events[replay].occurredAt)
                            : "无事件"}
                        </span>
                      </div>
                    )}{" "}
                    {!events.length ? (
                      <Empty
                        title="未发现可展示事件"
                        description="该来源可能只提供会话元数据。"
                      />
                    ) : (
                      <ol className="timeline">
                        {visibleEvents.map((e) => (
                          <li key={e.id}>
                            <div
                              className={`event-mark ${e.kind.includes("fail") || e.kind.includes("error") ? "error" : ""}`}
                            />
                            <div className="event-content">
                              <div className="between">
                                <strong>{eventName(e.kind)}</strong>
                                <time>{date(e.occurredAt, true)}</time>
                              </div>
                              {e.evidence !== "confirmed" && (
                                <div className="subline">
                                  {e.evidence === "inferred"
                                    ? "推断事件"
                                    : "待确认"}
                                </div>
                              )}
                              <details>
                                <summary>记录详情</summary>
                                <div className="subline">
                                  类型 {e.kind} · 轮次 {shortId(e.turnId)} ·
                                  记录时间 {date(e.observedAt, true)}
                                </div>
                                <JsonPreview value={e.data} />
                              </details>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                    {nextBefore && (
                      <Button
                        onClick={() => {
                          setCursor(nextBefore);
                          setReplay(null);
                        }}
                      >
                        加载更早的 200 条
                      </Button>
                    )}
                    {cursor && (
                      <Button onClick={() => setCursor(null)}>
                        返回最近事件
                      </Button>
                    )}
                  </>
                ))}
              {tab === "agents" && (
                <>
                  <p className="muted small">查看此任务的子任务与分支。</p>
                  <AgentTree
                    sessions={[
                      d.session,
                      ...d.agents.filter((a) => a.id !== d.session.id),
                    ]}
                    selected={id}
                    onSelect={onSelect}
                  />
                </>
              )}
              {tab === "usage" &&
                (d.session.metadataOnly ||
                d.session.usageAvailable === false ||
                !d.usage ? (
                  <Empty
                    title="Token 用量未知"
                    description="当前记录中没有用量数据。"
                    icon="usage"
                  />
                ) : (
                  <>
                    <div className="usage-detail-grid">
                      {[
                        ["输入 Token", d.usage.input],
                        ["其中：缓存输入", d.usage.cached],
                        ["输出 Token", d.usage.output],
                        ["其中：推理输出", d.usage.reasoning],
                      ].map(([label, value]) => (
                        <div className="metric small-metric" key={label}>
                          <span>{label}</span>
                          <strong>{number(value)}</strong>
                        </div>
                      ))}
                    </div>
                    {d.usageUncertain && (
                      <p className="amber">
                        部分用量无法完整统计，以下为已确认的最低用量。
                      </p>
                    )}
                    <div className="usage-total">
                      <span>本任务 Token 用量</span>
                      <strong>{number(d.usage.total)}</strong>
                    </div>
                    <p className="notice">
                      输入含缓存，输出含推理；子任务用量单独统计。
                    </p>
                    <p className="muted small">
                      任务 Token 用量不等于账号额度消耗。
                    </p>
                  </>
                ))}
              {tab === "notes" && (
                <>
                  <label className="check section-gap">
                    <input
                      type="checkbox"
                      checked={pinned}
                      onChange={(e) => setPinned(e.target.checked)}
                    />
                    固定关注这个会话
                  </label>
                  <label className="field">
                    <span>手动备注 · 仅保存在本产品</span>
                    <textarea
                      rows={6}
                      value={notes}
                      maxLength={10000}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="记录项目背景、待跟进事项…"
                    />
                  </label>
                  <Button variant="primary" onClick={save}>
                    保存备注
                  </Button>
                  <div className="danger-zone">
                    <h3>删除监控副本</h3>
                    <p>仅删除监控记录，Codex 原始记录保留。</p>
                    <Button
                      icon="trash"
                      variant="danger"
                      onClick={() => setConfirm(true)}
                    >
                      删除这个监控记录
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </aside>
      {confirm && (
        <ConfirmDialog
          title="删除这个会话的监控副本？"
          description="删除后不再显示或重新导入此监控记录。Codex 原始记录不受影响。"
          confirm="删除监控副本"
          onConfirm={remove}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
function eventName(kind: string) {
  const names: Record<string, string> = {
    session_meta: "会话元数据",
    session_start: "会话开始",
    turn_started: "轮次开始",
    turn_completed: "轮次完成",
    turn_failed: "轮次失败",
    turn_cancelled: "轮次中断",
    task_started: "任务开始",
    task_complete: "任务收尾",
    token_count: "Token 快照",
    usage: "用量观察",
    tool_call: "工具调用",
    tool_result: "工具结果",
    tool_activity: "工具执行中",
    tool_started: "工具开始执行",
    tool_finished: "工具执行结束",
    usage_response: "本次用量更新",
    usage_snapshot: "累计用量更新",
    user_message: "用户消息",
    agent_message: "助手回复",
    diagnostic: "诊断记录",
    hook_observation: "状态更新",
    agent_started: "子任务开始",
    agent_stopped: "子任务停止",
    session_ended: "会话结束",
    turn_resumed: "任务继续",
    turn_stopped: "本轮结束",
    tool_error: "工具错误（不代表任务失败）",
    waiting_user: "等待用户输入",
    waiting_approval: "等待执行审批",
    message: "会话消息",
    agent_spawn: "子 Agent 创建",
    turn_context: "轮次上下文",
    state: "状态事件",
  };
  return names[kind] || "活动记录";
}
