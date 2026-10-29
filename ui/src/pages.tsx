import { QuotaSources } from "./quota-source";
import {
  sessionForView,
  quotaWindow,
  quotasForOverview,
  quotaRemaining,
  accountName,
  sourceHealth,
  sourceKind,
} from "./observation";
import { useEffect, useState } from "react";
import {
  api,
  compact,
  relativeTime,
  date,
  download,
  mutate,
  number,
  shortId,
  useResource,
  type Accounts,
  type Overview,
  type Quota,
  type Settings,
  type Source,
  type List,
  type Session,
} from "./api";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  Empty,
  ErrorBox,
  FormField,
  Freshness,
  Icon,
  JsonPreview,
  Loading,
  Panel,
  QuotaCard,
  ScanBanner,
  StateBadge,
} from "./components";
import { AgentTree } from "./sessions";
import { PersonalSyncPage, SyncStatus } from "./sync";

type PageProps = {
  revision: number;
  notify: (text: string, error?: boolean) => void;
  onChanged: () => void;
};
export function OverviewPage({
  revision,
  notify,
  onChanged,
  onSelect,
  onNavigate,
  accounts,
}: PageProps & {
  onSelect: (id: string) => void;
  onNavigate: (page: string) => void;
  accounts: Accounts | null;
}) {
  const o = useResource<Overview>("/api/overview", revision);
  const [refreshing, setRefreshing] = useState(false);
  const d = o.data;
  const quotaOverview = quotasForOverview(d?.quotas || []);
  const activity = (d?.activity?.items || []).map((s) =>
    sessionForView(s, !!o.error),
  );
  const pending = activity.filter((s) =>
    ["waiting_user", "waiting_approval", "failed"].includes(s.state),
  );
  const running = activity.filter((s) => s.state === "running");
  const runningIds = new Set(running.map((s) => s.id));
  for (const s of running) {
    let p = s.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const ancestor = activity.find((a) => a.id === p);
      if (!ancestor || s.relation === "fork") break;
      runningIds.add(ancestor.id);
      p = ancestor.parentId;
    }
  }
  const runningTree = activity.filter((s) => runningIds.has(s.id));
  const activeSources = (d?.sources || []).filter(
    (s) => s.collectionEnabled !== false,
  );
  const issues =
    activeSources.filter(
      (s) =>
        s.errorCount > 0 ||
        !["ok", "healthy", "scanning"].includes(s.health) ||
        (s.health !== "scanning" &&
          (!s.lastScanAt || Date.now() - Date.parse(s.lastScanAt) > 120000)),
    ) || [];
  const refreshQuota = async () => {
    setRefreshing(true);
    try {
      await mutate("/api/quota/refresh");
      notify("额度已查询");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setRefreshing(false);
    }
  };
  const quotaCards = (quotas: Quota[]) => (
    <div className="quota-grid">
      {quotas.map((q) => (
        <QuotaCard
          key={`${q.id}:${q.pool}:${q.window}`}
          compactView
          quota={o.error ? { ...q, freshness: "unavailable" } : q}
          label={accounts?.accounts.find((a) => a.id === q.accountId)?.label}
          onBind={() => onNavigate("accounts")}
        />
      ))}
    </div>
  );
  return (
    <div className="personal-overview">
      <div className="page-heading compact-heading">
        <div>
          <h1>总览</h1>
        </div>
        <button
          className={`collector-summary ${issues.length || o.error ? "amber" : ""}`}
          onClick={() => onNavigate("settings")}
        >
          <Icon
            name={
              issues.length || o.error
                ? "warning"
                : activeSources.length
                  ? "check"
                  : "settings"
            }
            size={16}
          />
          {o.error
            ? "采集状态不可用"
            : !d
              ? "正在检查采集状态"
              : issues.length
                ? `${issues.length} 个来源需检查`
                : !activeSources.length
                  ? "未启用采集来源"
                  : d?.scan.phase === "scanning" ||
                      activeSources.some((s) => s.health === "scanning")
                    ? "正在读取记录"
                    : "采集正常"}
        </button>
      </div>
      {o.error && <ErrorBox message={o.error} onRetry={o.refresh} />}
      {!d ? (
        o.error ? null : (
          <Loading />
        )
      ) : (
        <>
          {d.scan.errors > 0 && !issues.length && (
            <div className="notice warning">
              采集有 {d.scan.errors} 条解析／访问问题，请到设置检查。
            </div>
          )}
          {issues.length > 0 && (
            <div className="notice warning">
              <Icon name="warning" />
              <span>
                {issues
                  .map(
                    (s) =>
                      `${s.label}：${s.errorCount ? `${s.errorCount} 个采集问题` : s.health === "ok" || s.health === "healthy" ? "采集已过期" : sourceHealth(s.health)}`,
                  )
                  .join("；")}
              </span>
              <Button onClick={() => onNavigate("settings")}>检查来源</Button>
            </div>
          )}
          <SyncStatus
            revision={revision}
            onNavigate={() => onNavigate("accounts")}
          />
          <Panel
            title="当前额度"
            action={
              <Button
                icon="refresh"
                disabled={refreshing}
                onClick={refreshQuota}
              >
                {refreshing ? "查询中…" : "刷新"}
              </Button>
            }
          >
            {d.quotas.length ? (
              <>
                {quotaOverview.current.length ? (
                  quotaCards(quotaOverview.current)
                ) : (
                  <div className="compact-empty">额度已过期，请刷新。</div>
                )}
                {quotaOverview.other.length > 0 && (
                  <details className="inline-details">
                    <summary>
                      更多额度记录（{quotaOverview.other.length}）
                    </summary>
                    {quotaCards(quotaOverview.other)}
                  </details>
                )}
              </>
            ) : (
              <div className="compact-empty">
                暂无额度数据，请先刷新。{" "}
                <button
                  className="text-button"
                  onClick={() => onNavigate("accounts")}
                >
                  查看账号
                </button>
              </div>
            )}
          </Panel>
          <div className="overview-activity">
            <Panel
              title="需要处理"
              action={
                <button
                  className="text-button"
                  onClick={() => onNavigate("live")}
                >
                  查看任务
                </button>
              }
            >
              {pending.length ? (
                <div className="compact-task-list">
                  {pending.slice(0, 4).map((s) => (
                    <TaskRow key={s.id} session={s} onSelect={onSelect} />
                  ))}
                  {pending.length > 4 && (
                    <button
                      className="text-button"
                      onClick={() => onNavigate("live")}
                    >
                      查看其余 {pending.length - 4} 项
                    </button>
                  )}
                </div>
              ) : (
                <div className="compact-empty">
                  {o.error ? "暂时无法判断待处理事项" : "暂无待处理事项"}
                </div>
              )}
            </Panel>
            <Panel
              title="正在运行"
              subtitle={
                o.error
                  ? "暂时无法获取任务状态"
                  : `${running.filter((s) => s.relation !== "spawn").length} 个主任务 · ${running.filter((s) => s.relation === "spawn").length} 个子任务`
              }
              action={
                <button
                  className="text-button"
                  onClick={() => onNavigate("live")}
                >
                  全部任务
                </button>
              }
            >
              {runningTree.length ? (
                <AgentTree
                  sessions={runningTree}
                  onSelect={onSelect}
                  compactView
                />
              ) : (
                <div className="compact-empty">
                  {o.error ? "当前运行状态未知" : "暂无运行中的任务"}
                </div>
              )}
              {d.activity?.truncated && (
                <p className="amber panel-note">
                  活动超过显示范围，请到任务页分页检查。
                </p>
              )}
            </Panel>
          </div>
          <div className="overview-bottom">
            <Panel
              title="最近完成"
              action={
                <button
                  className="text-button"
                  onClick={() => onNavigate("history")}
                >
                  全部历史
                </button>
              }
            >
              {d.recentCompleted?.length ? (
                <div className="compact-task-list">
                  {d.recentCompleted.slice(0, 3).map((s) => (
                    <TaskRow key={s.id} session={s} onSelect={onSelect} />
                  ))}
                </div>
              ) : (
                <div className="compact-empty">暂无已完成任务</div>
              )}
            </Panel>
            <Panel
              title="今日用量"
              subtitle="按 UTC 日期统计"
              action={
                <button
                  className="text-button"
                  onClick={() => onNavigate("usage")}
                >
                  完整趋势
                </button>
              }
            >
              <div className="today-total">
                {o.error
                  ? "—"
                  : `${d.usageUncertain ? "至少 " : ""}${compact(d.todayUsage?.total)}`}
                <small> Token</small>
              </div>
              {d.usageUncertain ? (
                <p className="muted">部分用量无法完整统计</p>
              ) : null}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
function TaskRow({
  session,
  onSelect,
}: {
  session: Session;
  onSelect: (id: string) => void;
}) {
  return (
    <button className="compact-task" onClick={() => onSelect(session.id)}>
      <span>
        <strong title={session.title}>
          {session.title || `任务 ${shortId(session.id)}`}
        </strong>
        <small>
          {session.relation === "spawn" ? "子任务" : "主任务"} ·{" "}
          {relativeTime(session.updatedAt)}
        </small>
      </span>
      <StateBadge session={session} />
    </button>
  );
}

type UsageReport = {
  usageUncertain?: boolean;
  days: {
    date: string;
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    total: number;
  }[];
  models: { model: string; total: number }[];
  projects: { project: string; total: number }[];
  quotas: Quota[];
  quotaHistory?: Quota[];
  officialUsage?: {
    observedAt: string;
    accountId: string | null;
    summary?: {
      lifetimeTokens?: number | null;
      totalSessions?: number | null;
      totalTurns?: number | null;
    } | null;
  }[];
};
export function UsagePage({
  revision,
  accounts,
}: {
  revision: number;
  accounts: Accounts | null;
}) {
  const [days, setDays] = useState(30),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const start = from
    ? new Date(from).toISOString()
    : new Date(new Date().setDate(new Date().getDate() - days))
        .toISOString()
        .slice(0, 10);
  const q = new URLSearchParams({
    from: start,
    ...(to ? { to: new Date(to + "T23:59:59.999Z").toISOString() } : {}),
  });
  const r = useResource<UsageReport>(`/api/usage?${q}`, revision),
    d = r.data;
  const official = d?.officialUsage
    ?.slice()
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const total = d?.days.reduce((n, x) => n + x.total, 0) || 0;
  const max = Math.max(1, ...(d?.days.map((x) => x.total) || []));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>用量与额度</h1>
        </div>
        <div className="segmented">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              className={!from && days === n ? "active" : ""}
              onClick={() => {
                setDays(n);
                setFrom("");
                setTo("");
              }}
            >
              近 {n} 天
            </button>
          ))}
        </div>
      </div>
      <div className="filter-line section-gap">
        <label className="inline-field">
          自
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="inline-field">
          至
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <span className="muted small">按 UTC 日期统计</span>
      </div>
      {r.error && <ErrorBox message={r.error} onRetry={r.refresh} />}{" "}
      {!d ? (
        <Loading />
      ) : (
        <>
          {d.usageUncertain && (
            <div className="notice warning">
              <Icon name="warning" />
              <span>部分用量无法完整统计，以下显示已确认的最低用量。</span>
            </div>
          )}
          <Panel
            title="每日用量"
            subtitle="空白日期表示没有记录。"
            action={
              <div className="chart-total">
                <strong>{compact(total)}</strong>
                <span>Token · 所选时间</span>
              </div>
            }
          >
            {d.days.length ? (
              <>
                <div
                  className="bar-chart"
                  role="img"
                  aria-label="按日可观测 Token 柱状图，完整数值可展开明细"
                >
                  <div className="chart-grid">
                    <span>{compact(max)}</span>
                    <span>{compact(max / 2)}</span>
                    <span>0</span>
                  </div>
                  <div className="bars">
                    {d.days.map((v) => (
                      <div
                        className="bar-slot"
                        key={v.date}
                        title={`${v.date}: ${number(v.total)} Token`}
                      >
                        <div
                          className="bar"
                          style={{
                            height: `${Math.max(1, (v.total / max) * 100)}%`,
                          }}
                        >
                          <span>{compact(v.total)}</span>
                        </div>
                        <label>{v.date.slice(5)}</label>
                      </div>
                    ))}
                  </div>
                </div>
                <details className="chart-details">
                  <summary>展开每日完整数值</summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>UTC 日期</th>
                          <th>输入</th>
                          <th>其中缓存</th>
                          <th>输出</th>
                          <th>其中推理</th>
                          <th>合计</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.days.map((x) => (
                          <tr key={x.date}>
                            <td>{x.date}</td>
                            <td>{number(x.input)}</td>
                            <td>{number(x.cached)}</td>
                            <td>{number(x.output)}</td>
                            <td>{number(x.reasoning)}</td>
                            <td>{number(x.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <Empty
                title="所选时间内没有用量记录"
                description="试试其他日期范围。"
                icon="usage"
              />
            )}
          </Panel>
          <div className="two-columns">
            <Panel title="按模型">
              <RankList
                rows={d.models.map((m) => ({
                  label: m.model || "模型未提供",
                  value: m.total,
                }))}
              />
            </Panel>
            <Panel title="按项目">
              <RankList
                rows={d.projects.map((p) => ({
                  label: p.project || "项目未识别",
                  value: p.total,
                }))}
              />
            </Panel>
          </div>
          <details className="section-disclosure">
            <summary>账号累计用量</summary>
            <Panel
              title="官方账号汇总"
              subtitle="最近一次账号查询结果，不随日期筛选变化。"
            >
              {official ? (
                <>
                  <p className="panel-note">
                    账号：
                    {accounts?.accounts.find((a) => a.id === official.accountId)
                      ?.label || accountName(official.accountId)}
                    {" · "}更新时间：{date(official.observedAt)}
                    {r.error ? " · 更新失败，显示上次记录" : ""}
                  </p>
                  <div className="usage-detail-grid">
                    {[
                      ["官方累计 Token", official.summary?.lifetimeTokens],
                      ["官方会话数", official.summary?.totalSessions],
                      ["官方轮次数", official.summary?.totalTurns],
                    ].map(([label, value]) => (
                      <div className="metric small-metric" key={String(label)}>
                        <span>{label}</span>
                        <strong>{number(value)}</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Empty
                  title="尚未取得官方账号汇总"
                  description="可在总览刷新额度后重试。"
                  icon="usage"
                />
              )}
            </Panel>
          </details>
          <details className="section-disclosure">
            <summary>额度详情与历史</summary>
            <Panel title="当前额度快照" subtitle="过期额度需刷新后才能确认。">
              {d.quotas.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>账号 / 额度池</th>
                        <th>窗口</th>
                        <th>剩余</th>
                        <th>重置时间</th>
                        <th>观察时间</th>
                        <th>更新状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.quotas.map((v, i) => (
                        <tr key={v.id || i}>
                          <td>
                            <strong>
                              {accounts?.accounts.find(
                                (a) => a.id === v.accountId,
                              )?.label || accountName(v.accountId)}
                            </strong>
                            <div className="subline">{v.pool}</div>
                          </td>
                          <td>{quotaWindow(v.window)}</td>
                          <td>
                            {quotaRemaining(v, !!r.error) === null
                              ? "未知"
                              : `${quotaRemaining(v, !!r.error)}%`}
                          </td>
                          <td>{date(v.resetsAt, true)}</td>
                          <td>{date(v.observedAt, true)}</td>
                          <td>
                            <Freshness
                              value={
                                v.resetsAt &&
                                new Date(v.resetsAt).getTime() <= Date.now()
                                  ? "stale"
                                  : r.error
                                    ? "unavailable"
                                    : v.freshness
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="尚无额度历史" description="请在总览刷新额度。" />
              )}
            </Panel>
            <Panel
              title="额度历史"
              subtitle="最近 200 条记录，仅供查看当时额度。"
            >
              {d.quotaHistory?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>观察时间</th>
                        <th>账号</th>
                        <th>额度池 / 窗口</th>
                        <th>当时剩余</th>
                        <th>当时记录的重置时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.quotaHistory.map((v, i) => (
                        <tr
                          key={
                            v.id ||
                            `${v.accountId}-${v.pool}-${v.window}-${v.observedAt}-${i}`
                          }
                        >
                          <td>{date(v.observedAt, true)}</td>
                          <td>
                            {accounts?.accounts.find(
                              (a) => a.id === v.accountId,
                            )?.label || accountName(v.accountId)}
                          </td>
                          <td>
                            {v.pool || "额度池未提供"}
                            <div className="subline">
                              {quotaWindow(v.window)}
                            </div>
                          </td>
                          <td>
                            {typeof v.remainingPercent === "number"
                              ? `${v.remainingPercent}%`
                              : "未知"}
                          </td>
                          <td>{date(v.resetsAt, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="尚无额度历史观察"
                  description="刷新额度后会在这里保留记录。"
                  icon="history"
                />
              )}
            </Panel>
          </details>
        </>
      )}
    </>
  );
}
function RankList({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.length ? (
    <div className="rank-list">
      {rows.slice(0, 12).map((r, i) => (
        <div className="rank-row" key={`${r.label}-${i}`}>
          <div className="between">
            <span title={r.label}>{r.label}</span>
            <strong>{compact(r.value)}</strong>
          </div>
          <div className="rank-meter">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty
      title="暂无分组数据"
      description="来源提供模型或项目标识后会显示在此。"
    />
  );
}

export function AccountsPage({
  revision,
  notify,
  onChanged,
  accounts,
  sources,
  onEnableCompany,
}: {
  revision: number;
  notify: (text: string, error?: boolean) => void;
  onChanged: () => void;
  accounts: Accounts | null;
  sources: Source[];
  onEnableCompany: () => void;
}) {
  const returnFlow = new URLSearchParams(location.hash.split("?")[1] ?? "").get(
    "return",
  );
  const returnLink = returnFlow === "company" ? "#company" : "#accounts?sync=1";
  const overview = useResource<Overview>("/api/overview", revision);
  const unbound =
    overview.data?.quotas.filter(
      (q) => q.unbound || q.accountId?.startsWith("unknown:"),
    ) || [];
  const [label, setLabel] = useState(""),
    [accountId, setAccount] = useState(""),
    [sourceId, setSource] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await mutate("/api/accounts", { label });
      setLabel("");
      notify("账号已添加，可继续关联历史记录");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const bind = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!from || !accountId || !sourceId) return;
    setBusy(true);
    try {
      await mutate("/api/bindings", {
        accountId,
        sourceId,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        evidence: "manual",
      });
      notify("所选记录已关联");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await mutate(
        `/api/bindings/${encodeURIComponent(id)}`,
        undefined,
        "DELETE",
      );
      notify("关联已取消");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <>
      {returnFlow && (
        <p>
          确认当前使用的账号后，<a href={returnLink}>返回共享范围</a>。
        </p>
      )}

      <div className="page-heading">
        <div>
          <h1>账号与设备</h1>
        </div>
      </div>
      {!!unbound.length && (
        <div className="notice warning">
          <Icon name="warning" />
          <span>{unbound.length} 条额度记录尚未关联账号。</span>
          <button
            className="text-button"
            onClick={() => {
              const target = document.getElementById(
                "quota-sources",
              ) as HTMLDetailsElement;
              if (target) {
                target.open = true;
                target.scrollIntoView({ block: "start" });
              }
            }}
          >
            关联账号
          </button>
        </div>
      )}
      <div className="two-columns">
        <Panel title="AI 账号">
          {accounts?.accounts.length ? (
            <div className="account-list">
              {accounts.accounts.map((a) => (
                <div className="account-row" key={a.id}>
                  <div className="avatar">{a.label.slice(0, 1)}</div>
                  <div>
                    <strong>{a.label}</strong>
                    <p>
                      {a.provider} ·{" "}
                      <span className="mono">{shortId(a.id)}</span>
                    </p>
                  </div>
                  <CopyButton value={a.id} label="复制" />
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="还没有已确认账号"
              description="在总览刷新额度，或添加账号名称后关联历史记录。"
            />
          )}
          <details className="inline-details">
            <summary>添加账号名称</summary>
            <form className="inline-form" onSubmit={create}>
              <input
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="新建账号名称，如：个人 Codex"
                aria-label="新建 AI 账号名称"
                required
              />
              <Button
                type="submit"
                icon="plus"
                disabled={busy || !label.trim()}
              >
                添加
              </Button>
            </form>
          </details>
        </Panel>
        <Panel title="设备与运行环境" subtitle="">
          <div className="source-list">
            {accounts?.devices.map((d) => (
              <div className="source-row" key={d.id}>
                <Icon name="accounts" />
                <div>
                  <strong>{d.label}</strong>
                  <p>本机设备</p>
                </div>
              </div>
            ))}
            {accounts?.environments.map((e) => (
              <div className="source-row" key={e.id}>
                <Icon name="accounts" />
                <div>
                  <strong>{e.label === "win32" ? "运行环境" : e.label}</strong>
                  <p>{sourceKind(e.kind)}</p>
                </div>
              </div>
            ))}
          </div>
          {!accounts?.devices.length && !accounts?.environments.length && (
            <Empty
              title="等待设备身份初始化"
              description="采集器启动后自动登记本机环境。"
            />
          )}
          <p className="panel-note">在下方「连接其他电脑」设置跨设备同步。</p>
        </Panel>
      </div>
      <SyncStatus revision={revision} />
      <details className="section-disclosure" id="account-binding">
        <summary>关联历史记录</summary>
        <Panel
          title="选择账号与记录范围"
          subtitle="仅关联所选来源和时间范围内的记录。已共享的记录需先撤回共享，才能取消关联。"
        >
          <form className="binding-form" onSubmit={bind}>
            <FormField label="AI 账号">
              <select
                required
                value={accountId}
                onChange={(e) => setAccount(e.target.value)}
              >
                <option value="">选择账号</option>
                {accounts?.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="采集来源">
              <select
                required
                value={sourceId}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">选择采集来源</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="开始时间（本机时区）">
              <input
                required
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </FormField>
            <FormField label="结束时间（本机时区）">
              <input
                required
                type="datetime-local"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </FormField>
            <Button variant="primary" disabled={busy} type="submit">
              关联记录
            </Button>
          </form>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>来源</th>
                  <th>有效区间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts?.bindings.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {accounts.accounts.find((a) => a.id === b.accountId)
                        ?.label || shortId(b.accountId)}
                    </td>
                    <td>
                      {sources.find((s) => s.id === b.sourceId)?.label ||
                        shortId(b.sourceId)}
                    </td>
                    <td>
                      {date(b.from)}
                      <div className="subline">
                        至 {b.to ? date(b.to) : "无结束时间"}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`tiny-label ${b.revoked ? "amber" : "mint"}`}
                      >
                        {b.revoked
                          ? "已撤销"
                          : b.evidence === "manual"
                            ? "人工确认"
                            : b.evidence}
                      </span>
                    </td>
                    <td>
                      {!b.revoked && (
                        <Button
                          variant="danger subtle"
                          onClick={() => setConfirm(b.id)}
                        >
                          取消关联
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!accounts?.bindings.length && (
              <p className="panel-note">尚无关联记录。</p>
            )}
          </div>
        </Panel>
      </details>
      <details className="section-disclosure">
        <summary>查看采集来源</summary>
        <Panel title="采集来源" subtitle="">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>环境 / 类型</th>
                  <th>状态</th>
                  <th>最近扫描</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.label}</strong>
                      <div className="subline">{s.pathLabel}</div>
                    </td>
                    <td>{sourceKind(s.kind)}</td>
                    <td>
                      {s.collectionEnabled === false
                        ? "历史来源 · 未启用"
                        : sourceHealth(s.health)}
                    </td>
                    <td>{date(s.lastScanAt, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </details>
      <div id="quota-sources">
        <QuotaSources
          revision={revision}
          accounts={accounts}
          notify={notify}
          onChanged={onChanged}
        />
      </div>
      <details
        className="section-disclosure"
        open={location.hash.includes("sync=1")}
      >
        <summary>连接其他电脑</summary>
        <PersonalSyncPage
          revision={revision}
          notify={notify}
          onChanged={onChanged}
          accounts={accounts}
        />
      </details>
      <div className="panel-note">
        需要团队汇总？
        <button className="text-button" onClick={onEnableCompany}>
          启用公司空间
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="取消这些记录的账号关联？"
          description="所选记录将恢复之前的账号归属；无法确认的显示为账号待确认。Codex 登录不受影响。"
          confirm="取消关联"
          onConfirm={() => revoke(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}

type HistoryRecoveryResult = {
  file: string;
  token?: string;
  backup?: string;
  counts: {
    sessionsRecovered: number;
    eventsAdded: number;
    eventsArchived: number;
    metadataDuplicatesArchived: number;
    quotasAdded: number;
    quotasArchived: number;
  };
};
function backupLabel(file: string) {
  const stamp = /^monitor-(\d+)\.sqlite$/.exec(file)?.[1];
  const timestamp = Number(stamp);
  const observed = new Date(timestamp);
  if (
    !stamp ||
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(observed.getTime())
  )
    return `监控备份 · 时间未知（${file}）`;
  return `${observed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })} · 监控备份（本机时间）`;
}
function BackupFilename({ file }: { file: string }) {
  return (
    <details>
      <summary>查看文件名</summary>
      <p className="mono">{file}</p>
    </details>
  );
}
export function SettingsPage({
  revision,
  notify,
  onChanged,
}: {
  revision: number;
  notify: (text: string, error?: boolean) => void;
  onChanged: () => void;
}) {
  const r = useResource<Settings>("/api/settings", revision);
  const [draft, setDraft] = useState<Settings | null>(null),
    [busy, setBusy] = useState(""),
    [backup, setBackup] = useState(""),
    [restore, setRestore] = useState(""),
    [historyFile, setHistoryFile] = useState(""),
    [historyPreview, setHistoryPreview] =
      useState<HistoryRecoveryResult | null>(null),
    [historyResult, setHistoryResult] = useState<HistoryRecoveryResult | null>(
      null,
    ),
    [historyError, setHistoryError] = useState(""),
    [confirm, setConfirm] = useState<"rebuild" | "restore" | "history" | null>(
      null,
    );
  useEffect(() => {
    if (r.data && !draft) setDraft(r.data);
  }, [r.data, draft]);
  const action = async (
    path: string,
    body?: unknown,
    success = "操作已完成",
  ) => {
    setBusy(path);
    try {
      const out = await mutate(path, body);
      notify(success);
      onChanged();
      return out;
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    await action(
      "/api/settings",
      {
        pollMs: Number(draft.pollMs),
        staleMs: Number(draft.staleMs),
        notifications: draft.notifications,
        retentionDays: Number(draft.retentionDays),
      },
      "设置已保存",
    );
  };
  const recoverHistory = async (apply: boolean) => {
    if (busy || !historyFile || (apply && !historyPreview?.token)) return;
    const file = historyFile;
    const token = historyPreview?.token;
    setBusy(apply ? "history-apply" : "history-preview");
    setHistoryError("");
    setHistoryPreview(null);
    setHistoryResult(null);
    try {
      const result = await mutate<HistoryRecoveryResult>(
        `/api/history-recovery/${apply ? "apply" : "preview"}`,
        { file, ...(apply ? { token } : {}) },
      );
      if (apply) {
        setHistoryResult(result);
        notify(`已补回 ${number(result.counts.eventsAdded)} 条历史记录`);
        onChanged();
      } else {
        if (result.file !== file || !result.token)
          throw Error("预览结果与所选备份不一致，请重新预览。");
        setHistoryPreview(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "历史补回失败";
      setHistoryError(message);
      notify(message, true);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>设置</h1>
        </div>
        <Button
          icon="refresh"
          disabled={!!busy}
          onClick={() =>
            action("/api/scan", undefined, "已请求扫描，进度会自动更新")
          }
        >
          重新扫描来源
        </Button>
      </div>
      {r.error && <ErrorBox message={r.error} onRetry={r.refresh} />}{" "}
      {r.data?.hookCleanupError && (
        <ErrorBox
          message={`增强状态配置清理未完成：${r.data.hookCleanupError}`}
        />
      )}
      {r.data?.hooksEnabled && r.data.hooks.status === "needs_setup" && (
        <div className="notice warning">
          <Icon name="warning" />
          <span>
            增强状态配置需要检查；展开高级设置处理。基础日志采集仍可使用。
          </span>
        </div>
      )}
      {r.data?.hooks.updateAvailable && (
        <div className="notice warning">
          <Icon name="warning" />
          <span>增强状态配置有更新，可更新以接收更多任务提醒。</span>
          <Button
            disabled={!!busy}
            onClick={async () => {
              const out = await action(
                "/api/settings",
                { hooksEnabled: true },
                "配置已更新；请在 Codex 确认新增配置的信任",
              );
              if (out) setDraft(out as Settings);
            }}
          >
            更新并启用配置
          </Button>
        </div>
      )}
      {!draft ? (
        <Loading />
      ) : (
        <>
          <div>
            <Panel
              title="通知与安静时段"
              subtitle="任务完成、失败或需要操作时提醒。"
            >
              <form onSubmit={save} className="settings-form">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.notifications?.enabled || false}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        notifications: {
                          ...draft.notifications,
                          enabled: e.target.checked,
                        },
                      })
                    }
                  />
                  启用任务通知
                </label>
                {draft.notifications?.enabled && (
                  <>
                    <div className="two-fields">
                      <FormField label="免打扰开始（本地时间）">
                        <input
                          type="time"
                          step={3600}
                          required
                          value={`${String(draft.notifications?.quietStart ?? 22).padStart(2, "0")}:00`}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              notifications: {
                                ...draft.notifications,
                                quietStart: Number(
                                  e.target.value.split(":")[0],
                                ),
                              },
                            })
                          }
                        />
                      </FormField>
                      <FormField label="免打扰结束（本地时间）">
                        <input
                          type="time"
                          step={3600}
                          required
                          value={`${String(draft.notifications?.quietEnd ?? 8).padStart(2, "0")}:00`}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              notifications: {
                                ...draft.notifications,
                                quietEnd: Number(e.target.value.split(":")[0]),
                              },
                            })
                          }
                        />
                      </FormField>
                    </div>
                    <FormField label="低额度提醒阈值（剩余 %）">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={draft.notifications?.quotaThreshold ?? 10}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            notifications: {
                              ...draft.notifications,
                              quotaThreshold: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                <details>
                  <summary>采集频率与状态更新</summary>{" "}
                  <FormField label="刷新间隔（秒）">
                    <input
                      aria-label="刷新间隔（秒）"
                      type="number"
                      min={0.5}
                      max={60}
                      step={0.5}
                      value={draft.pollMs / 1000}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          pollMs: Number(e.target.value) * 1000,
                        })
                      }
                    />
                  </FormField>
                  <FormField label="多久未更新后显示未知（秒）">
                    <input
                      aria-label="多久未更新后显示未知（秒）"
                      type="number"
                      min={5}
                      max={300}
                      step={1}
                      value={draft.staleMs / 1000}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          staleMs: Number(e.target.value) * 1000,
                        })
                      }
                    />
                  </FormField>
                </details>
                <Button type="submit" variant="primary" disabled={!!busy}>
                  保存设置
                </Button>
              </form>
            </Panel>
            <details className="section-disclosure" id="source-settings">
              <summary>采集来源</summary>
              <SourceSettings
                revision={revision}
                notify={notify}
                onChanged={onChanged}
              />
            </details>
            <details className="section-disclosure">
              <summary>高级设置与故障排查</summary>
              <Panel
                title="增强实时状态"
                subtitle="接收 Codex 的等待输入和审批提醒。"
              >
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.hooksEnabled === true}
                    disabled={!!busy}
                    onChange={async (e) => {
                      const enabled = e.target.checked;
                      const out = await action(
                        "/api/settings",
                        { hooksEnabled: enabled },
                        enabled
                          ? "配置已准备；首次请在 Codex 确认信任"
                          : "增强实时状态已关闭",
                      );
                      if (out) setDraft(out as Settings);
                    }}
                  />
                  增强实时状态
                </label>
                <div className="notice compact">
                  <Icon name="shield" size={18} />
                  <span>
                    {!draft.hooksEnabled
                      ? "已关闭，基础监控正常使用。"
                      : (r.data?.hooks.status || draft.hooks.status) ===
                          "observed"
                        ? "已收到状态事件。"
                        : (r.data?.hooks.status || draft.hooks.status) ===
                            "needs_setup"
                          ? "配置需要检查，请关闭后重试。"
                          : "配置已准备，等待 Codex 确认或新的状态事件。"}
                  </span>
                </div>
                {draft.hooksEnabled && (
                  <p className="muted">
                    首次使用：在 Codex 的 Hooks 审核入口确认 AI Work
                    Monitor；CLI 可输入 /hooks。若当前客户端没有 Hooks
                    入口，可继续使用基础监控。
                  </p>
                )}
                {draft.hookCleanupError && (
                  <p role="alert">{draft.hookCleanupError}</p>
                )}
                <details>
                  <summary>查看详情与配置</summary>
                  <p className="muted">{draft.hooks.explanation}</p>
                  <JsonPreview value={draft.hooks.preview} />
                  <p className="panel-note">
                    不会替你信任脚本，也不改变审批决定。关闭会停止接收并清理本产品条目，其他
                    Hooks 保留；已被手动修改的条目会提示处理。
                  </p>
                </details>
                <hr />
                <h3>桌面运行方式</h3>
                <p className="muted">
                  关闭窗口后继续监控。需要停止时，在任务栏托盘菜单选择“退出并停止本产品采集”。
                </p>
                <p className="panel-note">登录时启动可在托盘菜单中设置。</p>
              </Panel>

              <Panel
                title="联系支持"
                subtitle="遇到问题时，可导出不含对话正文和凭据的支持文件。"
              >
                <Button
                  onClick={async () => {
                    try {
                      const data = await api("/api/diagnostics");
                      download(
                        `ai-work-monitor-support-${new Date().toISOString().slice(0, 10)}.json`,
                        JSON.stringify(data, null, 2),
                      );
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  导出支持文件
                </Button>
              </Panel>
              <Panel
                title="补回旧监控历史"
                subtitle="从旧备份补回缺失记录，保留当前记录、设备身份和设置。"
              >
                <p className="muted">
                  先查看可补回的记录。补回前会自动备份，当前新增记录和原备份均保留。
                  不会自动合并账号身份，已删除的历史和已撤回的共享不会恢复。
                </p>
                <FormField label="选择用于补回历史的备份">
                  <select
                    aria-label="选择用于补回历史的备份"
                    value={historyFile}
                    disabled={!!busy}
                    onChange={(e) => {
                      setHistoryFile(e.target.value);
                      setHistoryPreview(null);
                      setHistoryResult(null);
                      setHistoryError("");
                    }}
                  >
                    <option value="">选择旧监控备份</option>
                    {r.data?.backups
                      .filter((file) => /^monitor-\d+\.sqlite$/.test(file))
                      .map((file) => (
                        <option key={file} value={file}>
                          {backupLabel(file)}
                        </option>
                      ))}
                  </select>
                </FormField>
                {historyFile && <BackupFilename file={historyFile} />}
                <Button
                  disabled={!historyFile || !!busy}
                  onClick={() => recoverHistory(false)}
                >
                  预览可补回的历史
                </Button>
                {busy === "history-preview" && (
                  <p role="status">正在核对历史，请稍候……</p>
                )}
                {busy === "history-apply" && (
                  <p role="status">正在备份并补回历史，请保持应用运行……</p>
                )}
                {historyError && <ErrorBox message={historyError} />}
                {(historyPreview || historyResult) &&
                  (() => {
                    const result = (historyResult || historyPreview)!;
                    const counts = result.counts;
                    return (
                      <div role="status">
                        <h3>{historyResult ? "实际补回结果" : "补回预览"}</h3>
                        <p>
                          {number(counts.sessionsRecovered)}{" "}
                          个会话补全历史；新增 {number(counts.eventsAdded)}{" "}
                          条记录、{number(counts.quotasAdded)} 条额度记录。
                        </p>
                        {historyResult?.backup ? (
                          <>
                            <p>
                              补回前备份：{backupLabel(historyResult.backup)}
                            </p>
                            <BackupFilename file={historyResult.backup} />
                          </>
                        ) : (
                          <p className="muted">
                            预览不会更改记录。补回期间新增的记录也会保留，完成后显示实际补回数量。
                          </p>
                        )}
                        {historyPreview && (
                          <Button
                            variant="primary"
                            disabled={!!busy}
                            onClick={() => setConfirm("history")}
                          >
                            备份并补回历史
                          </Button>
                        )}
                      </div>
                    );
                  })()}
              </Panel>
              <Panel
                title="备份与恢复"
                subtitle="备份监控记录，Codex 原始内容不受影响。"
              >
                <div className="maintenance-grid">
                  <div>
                    <h3>创建备份</h3>
                    <p>保存当前监控记录，便于以后恢复。</p>
                    <Button
                      icon="download"
                      disabled={!!busy}
                      onClick={async () => {
                        const b = await action(
                          "/api/backup",
                          undefined,
                          "监控备份已创建",
                        );
                        if (b?.file) setBackup(b.file);
                      }}
                    >
                      创建监控备份
                    </Button>
                    {backup && (
                      <>
                        <p className="mint">{backupLabel(backup)}</p>
                        <BackupFilename file={backup} />
                      </>
                    )}
                  </div>
                  <div>
                    <h3>恢复已创建备份</h3>
                    <p>
                      恢复会替换当前监控记录，并清除现有连接；之后需要重新配对。
                    </p>
                    <label className="field">
                      <span>选择备份</span>
                      <select
                        aria-label="选择要恢复的备份"
                        value={restore}
                        disabled={!!busy}
                        onChange={(e) => setRestore(e.target.value)}
                      >
                        <option value="">
                          {r.data?.backups.length
                            ? "选择要恢复的备份"
                            : "请先创建备份"}
                        </option>
                        {r.data?.backups.map((file) => (
                          <option key={file} value={file}>
                            {backupLabel(file)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {restore && <BackupFilename file={restore} />}
                    <Button
                      disabled={!restore || !!busy}
                      onClick={() => setConfirm("restore")}
                    >
                      恢复备份
                    </Button>
                  </div>
                  <div>
                    <h3>重新整理记录</h3>
                    <p>重新读取记录，保留备注、账号关联和已删除记录的设置。</p>
                    <Button
                      disabled={!!busy}
                      onClick={() => setConfirm("rebuild")}
                    >
                      重新整理
                    </Button>
                  </div>
                </div>
              </Panel>
            </details>
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title={
            confirm === "history"
              ? "备份并补回旧历史？"
              : confirm === "restore"
                ? "恢复监控备份？"
                : "重新整理监控记录？"
          }
          description={
            confirm === "history"
              ? `将从“${backupLabel(historyFile)}”补回缺失历史。补回前会自动备份，当前新增记录、设备身份和设置保留。已删除的记录和已撤回的共享不会恢复。`
              : confirm === "restore"
                ? `将用“${backupLabel(restore)}”替换当前监控记录，恢复前会先保存当前备份。现有连接会清除，恢复后须重新配对。已删除的记录和已撤回的共享不会恢复，Codex 原始历史不受影响。`
                : "重新读取并整理监控记录，保留备注、账号关联和已删除记录的设置。Codex 原始历史不作修改。"
          }
          confirm={
            confirm === "history"
              ? "确认备份并补回"
              : confirm === "restore"
                ? "恢复此备份"
                : "重新整理"
          }
          danger={confirm !== "history"}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm === "history") {
              void recoverHistory(true);
              return;
            }
            action(
              confirm === "restore" ? "/api/restore" : "/api/rebuild",
              confirm === "restore" ? { file: restore } : undefined,
              "维护操作已提交",
            );
          }}
        />
      )}
    </>
  );
}
function SourceSettings({ revision, notify, onChanged }: PageProps) {
  const sources = useResource<{ sources: Source[] }>("/api/sources", revision);
  const [label, setLabel] = useState(""),
    [path, setPath] = useState(""),
    [kind, setKind] = useState("windows-cli"),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<Source | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await mutate("/api/sources", { label, path, kind });
      setPath("");
      setLabel("");
      notify("已添加只读采集来源，开始扫描");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const deleteSource = async (source: Source) => {
    try {
      await mutate(
        `/api/sources/${encodeURIComponent(source.id)}`,
        undefined,
        "DELETE",
      );
      notify("已停止扫描该来源，已有监控历史保留");
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <Panel
      title="采集范围与目录"
      subtitle="自动读取本机 Codex，也可添加其他目录。"
    >
      {sources.error && (
        <ErrorBox message={sources.error} onRetry={sources.refresh} />
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>来源</th>
              <th>类型</th>
              <th>状态</th>
              <th>最后扫描</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sources.data?.sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.label}</strong>
                  <div className="subline">{s.pathLabel}</div>
                </td>
                <td>{sourceKind(s.kind)}</td>
                <td>
                  {s.collectionEnabled === false
                    ? "历史来源 · 未启用"
                    : sourceHealth(s.health)}
                  {s.collectionEnabled !== false && s.errorCount > 0 && (
                    <span className="amber"> · {s.errorCount} 个错误</span>
                  )}
                </td>
                <td>{date(s.lastScanAt, true)}</td>
                <td>
                  {s.collectionEnabled === false ? (
                    <span className="muted">保留历史记录</span>
                  ) : (
                    <Button
                      variant="danger subtle"
                      onClick={() => setRemove(s)}
                    >
                      停止此来源
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="source-add-disclosure">
        <summary>添加来源</summary>
        <form className="source-add-form" onSubmit={add}>
          <FormField label="来源别名">
            <input
              value={label}
              required
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="如：WSL 工作环境"
            />
          </FormField>
          <FormField label="运行环境类型">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="windows-cli">Windows 原生 CLI</option>
              <option value="windows-desktop">Windows 桌面端来源</option>
              <option value="wsl-cli">WSL CLI</option>
              <option value="manual">其他只读来源</option>
            </select>
          </FormField>
          <FormField
            label="Codex 数据目录绝对路径"
            hint="选择包含 Codex 历史记录的目录。"
          >
            <input
              value={path}
              required
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\\Users\\…\\.codex"
            />
          </FormField>
          <Button type="submit" disabled={busy} icon="plus">
            添加来源
          </Button>
        </form>
      </details>
      {remove && (
        <ConfirmDialog
          title={`停止扫描“${remove.label}”？`}
          description="停止此来源后不会再增量读取。已经保存的监控历史继续保留，Codex 原始目录不作修改。"
          confirm="停止此来源"
          onClose={() => setRemove(null)}
          onConfirm={() => deleteSource(remove)}
        />
      )}
    </Panel>
  );
}
