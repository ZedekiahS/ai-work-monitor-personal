export const PROTOCOL_VERSION = 1 as const;
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "invalid_request",
  "conflict",
  "rate_limited",
  "internal_error",
] as const;

export type Grant = {
  id: string;
  workspaceId: string;
  userId: string;
  accountIds: string[];
  projectIds: string[];
  from: string;
  to: string;
  shareQuota: boolean;
  retentionDays: number;
  revokedAt?: string | null;
};
export type WireEvent = {
  seq: number;
  eventId: string;
  grantId: string;
  provider: string;
  sourceId: string;
  environmentId: string;
  sessionId: string | null;
  turnId: string | null;
  agentId: string | null;
  parentId: string | null;
  relation: "spawn" | "fork" | null;
  accountId: string;
  projectId: string | null;
  projectAlias?: string;
  kind: string;
  occurredAt: string;
  observedAt: string;
  model: string | null;
  state: string | null;
  evidence: string;
  usage?: { input: number; cached: number; output: number; reasoning: number };
  quota?: {
    pool: string;
    window: string;
    remainingPercent: number | null;
    resetsAt: string | null;
  };
  correctsEventId?: string;
  expectedRevision?: number;
  revision?: number;
};
export class HttpError extends Error {
  get code() {
    return this.status === 401
      ? "unauthorized"
      : this.status === 403
        ? "forbidden"
        : this.status === 409
          ? "conflict"
          : this.status === 429
            ? "rate_limited"
            : this.status >= 500
              ? "internal_error"
              : "invalid_request";
  }
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const asObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new HttpError(400, "Expected object");
  return v as Record<string, unknown>;
};
export function fields(o: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw new HttpError(400, "Unexpected field; metadata allowlist only");
}
export function id(v: unknown, name = "id"): string {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(v))
    throw new HttpError(400, `Invalid ${name}`);
  return v;
}
export function alias(v: unknown): string {
  if (
    typeof v !== "string" ||
    v.trim().length < 1 ||
    v.length > 80 ||
    /[\x00-\x1f<>\\/]/.test(v)
  )
    throw new HttpError(400, "Invalid alias");
  return v.trim();
}
export function date(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new HttpError(400, "Invalid UTC date");
  return new Date(v).toISOString();
}
export function parseGrant(value: unknown): Omit<Grant, "id" | "userId"> {
  const o = asObject(value);
  fields(o, [
    "workspaceId",
    "accountIds",
    "projectIds",
    "from",
    "to",
    "shareQuota",
    "retentionDays",
  ]);
  const list = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 100)
      throw new HttpError(400, "Expected bounded ID list");
    return [...new Set(v.map((x) => id(x)))];
  };
  const g = {
    workspaceId: id(o.workspaceId),
    accountIds: list(o.accountIds),
    projectIds: list(o.projectIds),
    from: date(o.from),
    to: date(o.to),
    shareQuota: o.shareQuota === true,
    retentionDays: Number(o.retentionDays ?? 90),
  };
  if (
    !g.accountIds.length ||
    g.to <= g.from ||
    !Number.isInteger(g.retentionDays) ||
    g.retentionDays < 1 ||
    g.retentionDays > 365
  )
    throw new HttpError(400, "Invalid sharing scope");
  return g;
}
const states = [
  "running",
  "waiting_user",
  "waiting_approval",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];
const kinds = [
  "session",
  "session_meta",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "task_started",
  "task_start",
  "task_complete",
  "task_completed",
  "task_failed",
  "task_interrupted",
  "turn_start",
  "turn_end",
  "turn_aborted",
  "status",
  "waiting_user",
  "waiting_approval",
  "resumed",
  "agent_started",
  "agent_stopped",
  "subagent_start",
  "subagent_stop",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "tool_error",
  "tool_start",
  "tool_end",
  "usage",
  "usage_correction",
  "token_count",
  "quota",
  "heartbeat",
  "activity",
  "message",
];
export function parseEvent(value: unknown): WireEvent {
  const o = asObject(value);
  fields(o, [
    "seq",
    "eventId",
    "grantId",
    "provider",
    "sourceId",
    "environmentId",
    "sessionId",
    "turnId",
    "agentId",
    "parentId",
    "relation",
    "accountId",
    "projectId",
    "projectAlias",
    "kind",
    "occurredAt",
    "observedAt",
    "model",
    "state",
    "evidence",
    "usage",
    "quota",
    "correctsEventId",
    "expectedRevision",
    "revision",
  ]);
  if (!Number.isSafeInteger(o.seq) || Number(o.seq) < 1)
    throw new HttpError(400, "Invalid sequence");
  const nullable = (v: unknown) => (v == null ? null : id(v));
  const e: WireEvent = {
    seq: Number(o.seq),
    eventId: id(o.eventId),
    grantId: id(o.grantId),
    provider: id(o.provider),
    sourceId: id(o.sourceId),
    environmentId: id(o.environmentId),
    sessionId: nullable(o.sessionId),
    turnId: nullable(o.turnId),
    agentId: nullable(o.agentId),
    parentId: nullable(o.parentId),
    relation: o.relation == null ? null : (o.relation as "spawn" | "fork"),
    accountId: id(o.accountId),
    projectId: nullable(o.projectId),
    kind: id(o.kind),
    occurredAt: date(o.occurredAt),
    observedAt: date(o.observedAt),
    model: nullable(o.model),
    state: nullable(o.state),
    evidence: id(o.evidence),
  };
  if (
    (e.relation && !["spawn", "fork"].includes(e.relation)) ||
    (e.state && !states.includes(e.state)) ||
    !kinds.includes(e.kind) ||
    !["confirmed", "inferred", "unknown"].includes(e.evidence)
  )
    throw new HttpError(400, "Unsupported event semantics");
  const count = (v: unknown) => {
    if (!Number.isSafeInteger(v) || Number(v) < 0)
      throw new HttpError(400, "Invalid token count");
    return Number(v);
  };
  if (o.usage !== undefined) {
    const u = asObject(o.usage);
    fields(u, ["input", "cached", "output", "reasoning"]);
    e.usage = {
      input: count(u.input),
      cached: count(u.cached),
      output: count(u.output),
      reasoning: count(u.reasoning),
    };
    if (e.usage.cached > e.usage.input || e.usage.reasoning > e.usage.output)
      throw new HttpError(400, "Token subsets exceed totals");
  }
  if (o.quota !== undefined) {
    const q = asObject(o.quota);
    fields(q, ["pool", "window", "remainingPercent", "resetsAt"]);
    const p = q.remainingPercent;
    if (
      p !== null &&
      (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100)
    )
      throw new HttpError(400, "Invalid quota");
    e.quota = {
      pool: id(q.pool),
      window: id(q.window),
      remainingPercent: p as number | null,
      resetsAt: q.resetsAt == null ? null : date(q.resetsAt),
    };
  }
  if (e.usage && e.quota)
    throw new HttpError(400, "Quota and task usage are separate events");
  if (o.projectAlias !== undefined) e.projectAlias = alias(o.projectAlias);
  if (e.kind === "usage_correction") {
    e.correctsEventId = id(o.correctsEventId);
    e.expectedRevision = count(o.expectedRevision);
    e.revision = count(o.revision);
    if (
      !e.usage ||
      e.quota ||
      e.revision !== e.expectedRevision + 1 ||
      e.revision > 1000000000 ||
      !e.sessionId
    )
      throw new HttpError(400, "Invalid usage correction");
  } else if (
    o.correctsEventId !== undefined ||
    o.expectedRevision !== undefined ||
    o.revision !== undefined
  )
    throw new HttpError(400, "Revision fields require usage_correction");
  return e;
}
export function withinGrant(
  e: WireEvent,
  g: Grant,
  now = Date.now(),
): string | null {
  if (g.revokedAt) return "grant_revoked";
  if (e.grantId !== g.id || !g.accountIds.includes(e.accountId))
    return "account_not_shared";
  if (
    Date.parse(e.occurredAt) < Date.parse(g.from) ||
    Date.parse(e.occurredAt) >= Date.parse(g.to)
  )
    return "outside_time_scope";
  if (Date.parse(e.occurredAt) < now - g.retentionDays * 86400000)
    return "retention_expired";
  if (Date.parse(g.to) <= now) return "grant_expired";
  if (
    Date.parse(e.occurredAt) > now + 300000 ||
    Date.parse(e.observedAt) > now + 300000
  )
    return "future_clock";
  if (e.quota) return g.shareQuota ? null : "quota_not_shared";
  if (!e.projectId || !g.projectIds.includes(e.projectId))
    return "project_not_shared";
  return null;
}
export const previewFields = [
  "opaque account ID",
  "project ID (explicit selection)",
  "source/environment/device IDs",
  "session/turn/agent IDs",
  "timestamps",
  "model",
  "state/evidence",
  "token increments (input/output with subsets)",
  "quota only with separate consent",
];
