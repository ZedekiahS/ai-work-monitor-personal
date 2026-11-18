import React, { useState } from "react";
import type {
  cliPresence,
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
  onSourceSettings: () => void;
};

function sessionDescription(files: Files["sessions"]) {
  switch (files) {
    case "found":
      return "已找到可读的会话日志";
    case "empty":
      return "目录中暂无会话日志";
    case "limited":
      return "已检查部分目录，尚未找到会话日志";
    case "missing":
      return "目录不存在";
    default:
      return "无法读取，请检查目录权限";
  }
}

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

function SourceCheck({ sourceId }: { sourceId: string | null }) {
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
    needs_setup: "请在 Monitor 设置中检查 Hooks 配置",
    awaiting_event: "已启用，等待首个事件",
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
            <>
              <ResultRow
                title="来源目录"
                value={
                  {
                    readable: "可以读取",
                    missing: "目录不存在，请确认来源路径。",
                    unreadable: "无法读取，请确认路径和访问权限。",
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
                    value={sessionDescription(report.archived)}
                  />
                </>
              )}
              <ResultRow
                title="Monitor 最近收录的会话活动"
                value={
                  report.latest ? date(report.latest) : "此来源暂无已收录的会话"
                }
              />
            </>
          )}
          <ResultRow
            title="本机 Codex CLI"
            value={
              report.cli.status === "available"
                ? `版本 ${report.cli.version}`
                : report.cli.status === "missing"
                  ? "未找到 Codex CLI"
                  : "无法读取版本，请检查 Codex 安装"
            }
          />
          <ResultRow
            title="本机 Monitor Hooks"
            value={hookStates[report.hooks.status] || "状态未知"}
          />
        </div>
      )}
    </>
  );
}

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
    missing: "未找到 Codex CLI。请确认已安装 Codex，且可在终端运行。",
    unsupported: "此版本的 Codex 未提供 JSON 诊断，可更新 Codex 后重试。",
    timeout: "诊断超时，请稍后重试。",
    failed: "未取得有效的诊断报告，请在本机终端运行 codex doctor 查看详情。",
  };
  return (
    <Panel
      title="Codex 诊断"
      subtitle="使用本机 Codex 的当前配置，包含网络连接检查。"
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
                  <p className="muted">
                    请查看{report.attention.join("、")}，可在终端运行 codex
                    doctor 查看详情。
                  </p>
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
  const [chosen, setChosen] = useState(initialSourceId);
  const active = sources.filter((source) => source.collectionEnabled !== false);
  const selected = chosen || active[0]?.id || "";
  const available = active.some((source) => source.id === selected);
  return (
    <Panel
      title={active.length ? "来源检查" : "本机检查"}
      subtitle={
        active.length
          ? undefined
          : "尚无启用的采集来源。可检查本机 CLI 和 Hooks，或在来源设置中添加 Codex 历史目录。"
      }
      action={
        <Button onClick={onSourceSettings} icon="settings">
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
                onChange={(event) => setChosen(event.target.value)}
              >
                {!available && (
                  <option value={selected} disabled>
                    此来源已停用或移除，请重新选择
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
          {available && <SourceCheck key={selected} sourceId={selected} />}
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
