import path from "node:path";
import { Event, ParserContext, hash, usageOf } from "../core/model.js";
const validDate = (x: any, fallback: string) =>
  typeof x === "string" && !Number.isNaN(Date.parse(x))
    ? new Date(x).toISOString()
    : fallback;
export function parseLine(
  raw: string,
  ctx: ParserContext,
  position: number,
  observedAt = new Date().toISOString(),
): Event | null {
  const row = JSON.parse(raw);
  const p = row.payload ?? {};
  const ordinal = Number.isSafeInteger(row.ordinal) ? row.ordinal : position;
  if (ctx.headerSeen && row.type === "session_meta") return null;
  const inherited =
    ctx.headerSeen && ctx.cutoff !== null && ordinal < ctx.cutoff;
  // Only cumulative counters can establish the inherited baseline. Do not let
  // inherited headers, turn context, text, tool activity or quota enter the child.
  if (
    inherited &&
    !(
      row.type === "event_msg" &&
      p.type === "token_count" &&
      p.info?.total_token_usage
    )
  )
    return null;
  const at = validDate(row.timestamp, observedAt);
  let kind = "",
    data: Record<string, any> = {},
    upstreamId: string | null = null;
  if (row.type === "session_meta") {
    ctx.headerSeen = true;
    ctx.sessionId = String(p.id ?? p.session_id ?? ctx.sessionId);
    ctx.agentId =
      typeof p.agent_id === "string" && p.agent_id ? p.agent_id : ctx.sessionId;
    const a = p.creator_account_id;
    if (typeof a === "string" && a) ctx.accountId = "codex:" + hash(a);
    const normalized = typeof p.cwd === "string" ? path.normalize(p.cwd) : "";
    ctx.projectId = normalized
      ? "project:" + hash(ctx.environmentId + ":" + normalized)
      : "unknown";
    ctx.cutoff = Number.isSafeInteger(p.subagent_history_start_ordinal)
      ? p.subagent_history_start_ordinal
      : null;
    ctx.forked = !!p.forked_from_id;
    const spawn =
      p.source?.subagent?.thread_spawn ??
      p.thread_source?.subagent?.thread_spawn;
    kind = "session_meta";
    data = {
      parentId:
        spawn?.parent_thread_id ??
        p.parent_thread_id ??
        p.forked_from_id ??
        null,
      relation:
        spawn?.parent_thread_id || p.parent_thread_id
          ? "spawn"
          : p.forked_from_id
            ? "fork"
            : null,
      projectLabel: normalized ? path.basename(normalized) : "未知项目",
      projectPath: normalized,
      title:
        p.agent_path ??
        p.agent_nickname ??
        (p.source?.subagent?.other
          ? "内部 " + p.source.subagent.other
          : "Codex 会话"),
      agentPath: p.agent_path ?? null,
      agentId: ctx.agentId,
      agentIdentityBasis:
        typeof p.agent_id === "string" && p.agent_id
          ? "source_agent_id"
          : "thread_header_id",
      reportedSessionId: typeof p.session_id === "string" ? p.session_id : null,
      client: p.originator ?? "unknown",
      version: p.cli_version ?? null,
      cutoff: ctx.cutoff,
      forked: ctx.forked,
      accountEvidence: ctx.accountId ? "session_header" : "unknown",
      sourceType:
        typeof p.source === "string"
          ? p.source
          : spawn
            ? "subagent"
            : "unknown",
    };
  } else if (row.type === "turn_context") {
    ctx.turnId = p.turn_id ?? ctx.turnId;
    ctx.model = p.model ?? ctx.model;
    kind = "turn_context";
    data = { model: ctx.model };
  } else if (row.type === "token_usage_record") {
    kind = "usage_response";
    upstreamId = p.response_id ?? null;
    data = {
      usage: usageOf(p.usage),
      model: ctx.model,
      inherited: ctx.cutoff !== null && ordinal < ctx.cutoff,
      usageUncertain: ctx.forked && ctx.cutoff === null,
    };
    ctx.hasResponseUsage = true;
  } else if (row.type === "event_msg") {
    const t = p.type;
    const names: Record<string, string> = {
      task_started: "turn_started",
      task_complete: "turn_completed",
      task_completed: "turn_completed",
      turn_aborted: "turn_cancelled",
      turn_interrupted: "turn_cancelled",
    };
    if (names[t]) {
      kind = names[t];
      data = { model: ctx.model };
      if (kind === "turn_started") ctx.turnId = p.turn_id ?? ctx.turnId;
    } else if (t === "token_count" && p.info?.total_token_usage) {
      kind = "usage_snapshot";
      data = {
        usage: usageOf(p.info.total_token_usage),
        model: ctx.model,
        rateLimits: inherited ? null : (p.rate_limits ?? null),
        inherited,
        ...(inherited ? { baselineOnly: true } : {}),
        usageUncertain: ctx.forked && ctx.cutoff === null,
      };
    } else if (t === "user_message" || t === "agent_message") {
      kind = t;
      data = {
        text: typeof p.message === "string" ? p.message.slice(0, 50000) : "",
        model: ctx.model,
      };
    } else if (t === "error") {
      kind = "diagnostic";
      data = {
        category: "upstream_error",
        message: "记录了上游错误事件；未据此断定任务失败",
      };
    } else if (t === "item_completed") {
      kind = "tool_activity";
      data = {
        type: p.item?.type ?? "item",
        status: p.item?.status ?? "completed",
        name: p.item?.name ?? null,
      };
    }
  } else if (row.type === "response_item") {
    if (["function_call", "custom_tool_call"].includes(p.type)) {
      kind = "tool_started";
      data = { name: p.name ?? "tool", callId: p.call_id ?? null };
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(p.type)
    ) {
      kind = "tool_finished";
      data = { callId: p.call_id ?? null, status: p.status ?? "observed" };
    } else if (
      (p.type === "message" && ["user", "assistant"].includes(p.role)) ||
      p.type === "agent_message"
    ) {
      kind = p.role === "user" ? "user_message" : "agent_message";
      data = {
        text: (typeof p.content === "string"
          ? p.content
          : (Array.isArray(p.content) ? p.content : [])
              .filter(
                (c: any) =>
                  typeof c === "string" ||
                  ["text", "input_text", "output_text"].includes(c.type),
              )
              .map((c: any) => (typeof c === "string" ? c : (c.text ?? "")))
              .join("\n")
        ).slice(0, 50000),
      };
    }
  }
  if (!kind) return null;
  data.accountEvidence = "session_creator_only";
  if (data.usageUncertain) data.inherited = true; // A fork with no boundary is visible but excluded from totals.
  // Same transcript copied between devices/WSL has identical business identity.
  const id =
    "evt:" +
    hash(
      [
        "codex",
        ctx.sessionId,
        String(ordinal),
        row.type,
        p.type ?? "",
        upstreamId ?? "",
        hash(raw),
      ].join(":"),
    );
  return {
    id,
    upstreamId,
    provider: "codex",
    deviceId: ctx.deviceId,
    environmentId: ctx.environmentId,
    sourceId: ctx.sourceId,
    sessionId: ctx.sessionId,
    turnId:
      p.turn_id ??
      p.internal_chat_message_metadata_passthrough?.turn_id ??
      ctx.turnId,
    agentId: ctx.agentId ?? ctx.sessionId,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    kind,
    occurredAt: at,
    observedAt,
    receivedAt: observedAt,
    sequence: ordinal,
    schemaVersion: 2,
    evidence: kind === "diagnostic" ? "unknown" : "confirmed",
    data,
  };
}
