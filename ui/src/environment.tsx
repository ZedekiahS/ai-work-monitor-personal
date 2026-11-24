import React, { useState } from "react";
import type {
  cliPresence,
  DoctorFinding,
  inspectSourceDirectories,
  runCodexDoctor,
} from "../../server/environment";
import { date, mutate, type Source } from "./api";
import { Button, ErrorBox, FormField, Panel } from "./components";

type Files = Awaited<ReturnType<typeof inspectSourceDirectories>>;
type LocalReport = (
  | { sourceId: null }
  | (Files & { sourceId: string; latest: string | null })
) & {
  checkedAt: string;
  cli: Awaited<ReturnType<typeof cliPresence>>;
  hooks: { status: string; lastEvent: string | null };
};
type Doctor = Awaited<ReturnType<typeof runCodexDoctor>>;
type Props = {
  sources: Source[];
  initialSourceId: string;
  onReturn?: () => void;
  onSourceSettings: (sourceId: string) => void;
};

function sessionDescription(files: Files["sessions"], archived = false) {
  switch (files) {
    case "found":
      return "已找到可打开的会话日志文件";
    case "empty":
      return archived
        ? "暂无归档日志文件"
        : "未找到会话日志文件。若已有会话，请在「来源设置」核对目录。";
    case "limited":
      return "已检查部分目录，尚未找到日志。请在「来源设置」核对目录。";
    case "missing":
      return archived
        ? "没有归档目录"
        : "没有 sessions 目录。请在「来源设置」核对 Codex 历史目录。";
    default:
      return "无法读取。请确认当前 Windows 用户有权访问该目录，再重新检查。";
  }
}

const cliMessages = {
  missing:
    "找不到 codex 命令。请确认已安装 Codex CLI，并在新终端运行 codex --version。",
  unavailable:
    "Codex 命令执行失败。请在本机终端运行 codex --version，检查安装路径和执行权限。",
  unrecognized:
    "Codex 已运行，但版本号无法识别。请在本机终端运行 codex --version 核对版本。",
  timeout:
    "读取版本超时。请在本机终端运行 codex --version，确认有响应后重新检查。",
};

function ResultRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="source-row">
      <div>
        <strong>{title}</strong>
        <p>{value}</p>
      </div>
    </div>
  );
}

function SourceCheck({
  sourceId,
  sourceLabel,
}: {
  sourceId: string | null;
  sourceLabel?: string;
}) {
  const [report, setReport] = useState<LocalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setBusy(true);
    setReport(null);
    setError("");
    try {
      const result = await mutate<LocalReport>(
        "/api/environment/source-check",
        sourceId === null ? {} : { sourceId },
      );
      if (result.sourceId === sourceId) setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "检查失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  const hookStates: Record<string, string> = {
    off: "未启用",
    needs_setup: "配置尚未就绪。请在「监控设置」检查增强实时状态配置。",
    awaiting_event:
      "尚未收到事件。请在 Codex 中确认已信任该 Hook，再开始一次任务。",
    observed: `已收到事件${report?.hooks.lastEvent ? ` · ${date(report.hooks.lastEvent)}` : ""}`,
  };
  return (
    <>
      <div className="settings-form">
        <div className="actions">
          <Button variant="primary" icon="play" disabled={busy} onClick={check}>
            {busy
              ? "正在检查…"
              : report
                ? "重新检查"
                : sourceId === null
                  ? "检查本机"
                  : "检查来源"}
          </Button>
          {report && <small className="muted">{date(report.checkedAt)}</small>}
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {report && (
        <div className="source-list" aria-live="polite">
          {report.sourceId !== null && (
            <section aria-label="所选来源">
              <h3>{sourceLabel ? `采集来源 · ${sourceLabel}` : "所选来源"}</h3>
              <ResultRow
                title="来源目录"
                value={
                  {
                    readable: "可以读取",
                    missing:
                      "目录不存在。请在「来源设置」核对位置或选择其他来源。",
                    unreadable:
                      "无法读取。请确认当前 Windows 用户可以打开此目录，再重新检查。",
                  }[report.directory]
                }
              />
              {report.directory === "readable" && (
                <>
                  <ResultRow
                    title="会话日志"
                    value={sessionDescription(report.sessions)}
                  />
                  <ResultRow
                    title="已归档会话"
                    value={sessionDescription(report.archived, true)}
                  />
                </>
              )}
              <ResultRow
                title="Monitor 中该来源的最新会话活动"
                value={
                  report.latest
                    ? date(report.latest)
                    : report.sessions === "found" || report.archived === "found"
                      ? "已找到日志文件，Monitor 暂无此来源的会话记录。请到「监控设置」重新扫描来源，再回到任务页查看。"
                      : "暂无该来源的会话记录"
                }
              />
            </section>
          )}
          <section aria-label="本机运行环境">
            <h3>本机运行环境</h3>
            <ResultRow
              title="本机 Codex CLI"
              value={
                report.cli.status === "available"
                  ? `版本 ${report.cli.version}`
                  : cliMessages[report.cli.status]
              }
            />
            <ResultRow
              title="本机 Monitor Hooks"
              value={hookStates[report.hooks.status] || "状态未知"}
            />
          </section>
        </div>
      )}
    </>
  );
}

const nextSteps: Record<DoctorFinding, string> = {
  登录: "在 Codex 中确认当前账号已登录，再运行诊断。",
  后台服务:
    "重启 Codex 后重试。若仍有异常，在终端运行 codex doctor 查看服务状态。",
  配置: "在终端运行 codex doctor，核对提示的配置项后重试。",
  桌面应用: "打开 Codex 桌面应用，确认它可以启动，再运行诊断。",
  磁盘: "检查安装目录和用户目录所在磁盘的可用空间与访问权限。",
  Git: "在本机终端运行 git --version，核对 Git 安装和命令路径。",
  安装: "在新终端运行 codex --version，核对当前使用的 Codex 安装。",
  MCP: "在 Codex 中核对 MCP 服务的配置和连接状态，再运行诊断。",
  网络: "检查本机网络连接。如使用代理，请核对代理设置后重试。",
  运行时: "在终端运行 codex doctor，按报告核对所需的运行时组件。",
  沙箱: "在终端运行 codex doctor，查看受限的操作和目录权限。",
  安全: "在终端运行 codex doctor，核对报告中标出的权限或配置项。",
  系统: "在终端运行 codex doctor，核对报告中标出的系统要求。",
  更新: "检查 Codex CLI 是否有可用更新，更新后重新运行诊断。",
  其他检查: "在终端运行 codex doctor，查看该项的本地报告。",
};

function CodexDoctor() {
  const [report, setReport] = useState<Doctor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setReport(null);
    setError("");
    setBusy(true);
    try {
      setReport(await mutate<Doctor>("/api/environment/codex-doctor", {}));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "无法运行 Codex 诊断，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  const messages = {
    missing: cliMessages.missing,
    unsupported:
      "此 Codex CLI 未提供兼容的 JSON 诊断。请更新 Codex CLI 后重试。",
    timeout:
      "诊断超时，未取得完整结果。请确认本机 Codex 命令和网络连接可用，再运行诊断。",
    failed:
      "诊断命令执行失败。请在本机终端运行 codex doctor 查看错误，再重试。",
    incompatible_report:
      "无法识别 Codex 返回的诊断报告。请在本机终端运行 codex doctor 查看结果。",
  };
  return (
    <Panel
      title="Codex 诊断"
      subtitle="手动运行本机 Codex 官方诊断，会检查网络连接。页面仅显示检查分类和统计。"
    >
      <div className="settings-form">
        <Button onClick={check} disabled={busy}>
          {busy ? "正在诊断…" : "运行 Codex 诊断"}
        </Button>
        {error && <ErrorBox message={error} />}
        {report && (
          <div role="status">
            {report.state === "complete" ? (
              <>
                <strong>
                  {
                    {
                      ok: "全部通过",
                      warning: "有项目需要关注",
                      fail: "发现异常",
                    }[report.overall]
                  }
                </strong>
                <p className="muted">
                  {report.counts.ok} 项通过 · {report.counts.warning} 项提醒 ·{" "}
                  {report.counts.fail} 项异常
                </p>
                {report.attention.length > 0 && (
                  <ul aria-label="建议操作">
                    {report.attention.map((category) => (
                      <li key={category}>
                        <strong>{category}</strong> · {nextSteps[category]}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              messages[report.state]
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function SourcePanel({ sources, initialSourceId, onSourceSettings }: Props) {
  const active = sources.filter((source) => source.collectionEnabled !== false);
  const [selected, setSelected] = useState(
    () => initialSourceId || (active.length === 1 ? active[0].id : ""),
  );
  const selectedSource = active.find((source) => source.id === selected);
  return (
    <Panel
      title={active.length ? "来源检查" : "本机检查"}
      subtitle={
        active.length
          ? undefined
          : selected
            ? "原采集来源已停用或移除。可检查本机 CLI 和 Hooks，或在来源设置中添加目录。"
            : "尚无启用的采集来源。可检查本机 CLI 和 Hooks，或在来源设置中添加 Codex 历史目录。"
      }
      action={
        <Button onClick={() => onSourceSettings(selected)} icon="settings">
          来源设置
        </Button>
      }
    >
      {active.length ? (
        <>
          <div className="settings-form">
            <FormField label="采集来源">
              <select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {!selectedSource && (
                  <option value={selected} disabled>
                    {selected
                      ? "此来源已停用或移除，请重新选择"
                      : "选择要检查的来源"}
                  </option>
                )}
                {active.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          {selectedSource && (
            <SourceCheck
              key={selected}
              sourceId={selected}
              sourceLabel={selectedSource.label}
            />
          )}
        </>
      ) : (
        <SourceCheck sourceId={null} />
      )}
    </Panel>
  );
}

export function EnvironmentPage(props: Props) {
  return (
    <>
      <div className="page-heading">
        <h1>环境检查</h1>
        {props.onReturn && (
          <Button onClick={props.onReturn}>返回 Monitor 任务</Button>
        )}
      </div>
      <SourcePanel key={props.initialSourceId} {...props} />
      <CodexDoctor />
    </>
  );
}
