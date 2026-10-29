import { createHash } from "node:crypto";
export type State =
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";
export type Evidence = "confirmed" | "inferred" | "unknown";
export interface Usage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}
export const zeroUsage = (): Usage => ({
  input: 0,
  cached: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});
export function usageOf(x: any): Usage {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const input = n(x?.input_tokens ?? x?.input),
    output = n(x?.output_tokens ?? x?.output);
  return {
    input,
    cached: Math.min(input, n(x?.cached_input_tokens ?? x?.cached)),
    output,
    reasoning: Math.min(output, n(x?.reasoning_output_tokens ?? x?.reasoning)),
    total: input + output,
  };
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export interface Event {
  id: string;
  upstreamId: string | null;
  provider: string;
  deviceId: string;
  environmentId: string;
  sourceId: string;
  sessionId: string;
  turnId: string | null;
  agentId: string;
  accountId: string | null;
  projectId: string;
  kind: string;
  occurredAt: string;
  observedAt: string;
  receivedAt: string;
  sequence: number;
  schemaVersion: number;
  evidence: Evidence;
  data: Record<string, any>;
}
export interface Session {
  id: string;
  title: string;
  project: string;
  model: string;
  sourceId: string;
  accountId: string | null;
  parentId: string | null;
  relation: "spawn" | "fork" | null;
  startedAt: string;
  updatedAt: string;
  stateOccurredAt?: string | null;
  stateObservedAt?: string | null;
  turnId: string | null;
  state: State;
  lastState: State;
  evidence: Evidence;
  freshness: "fresh" | "stale" | "unavailable";
  totalTokens: number | null;
  metadataOnly?: boolean;
  usageAvailable?: boolean;
  usageUncertain?: boolean;
  pinned: boolean;
  notes: string;
  jumpUrl: string | null;
}
export interface ParserContext {
  deviceId: string;
  environmentId: string;
  sourceId: string;
  sessionId: string;
  accountId: string | null;
  projectId: string;
  turnId: string | null;
  model: string;
  cutoff: number | null;
  forked: boolean;
  hasResponseUsage: boolean;
  headerSeen?: boolean;
  agentId?: string;
  baselineParsingVersion?: number;
}
export interface Source {
  id: string;
  label: string;
  kind: string;
  environmentId: string;
  pathLabel: string;
  health: string;
  lastScanAt: string | null;
  errorCount: number;
  capabilities: Record<string, string>;
}
export interface Scan {
  phase: "idle" | "scanning" | "error";
  filesTotal: number;
  filesDone: number;
  eventsImported: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface Quota {
  identityEvidence?: "unconfirmed" | "manual" | "confirmed";
  id: string;
  accountId: string | null;
  pool: string;
  window: string;
  remainingPercent: number | null;
  resetsAt: string | null;
  observedAt: string;
  freshness: string;
  sourceId: string;
}
export const terminal = new Set<State>(["completed", "failed", "cancelled"]);
export function presentState(
  s: Session,
  now = Date.now(),
  staleMs = 15000,
  available = true,
): Session {
  const stateAt = s.stateOccurredAt ?? s.updatedAt;
  const age = now - Date.parse(stateAt);
  const fresh =
    available && Number.isFinite(age) && age >= -1000 && age < staleMs;
  const freshness = available ? (fresh ? "fresh" : "stale") : "unavailable";
  return {
    ...s,
    lastState: s.state,
    state: !terminal.has(s.state) && !fresh ? "unknown" : s.state,
    freshness,
  };
}
function stateFromWaits(
  waits: { state: "waiting_user" | "waiting_approval" }[],
): State {
  return waits.some((wait) => wait.state === "waiting_approval")
    ? "waiting_approval"
    : waits.length
      ? "waiting_user"
      : "running";
}
export function applyState(
  current: {
    state: State;
    turnId: string | null;
    at: string;
    evidence: Evidence;
    observedAt?: string;
    waits?: {
      id: string;
      callId: string | null;
      agentId: string;
      state: "waiting_user" | "waiting_approval";
    }[];
  },
  event: Event,
) {
  const waiting =
    current.state === "waiting_user" || current.state === "waiting_approval";
  // Completion of an unrelated parallel tool is activity, not evidence that
  // the user answered this question. PermissionRequest has no documented call
  // id; its wait is deliberately not guessed from tool name or nearby time.
  if (
    waiting &&
    event.kind === "tool_finished" &&
    event.turnId === current.turnId &&
    event.data.hookEvent === "PostToolUse"
  ) {
    const remaining = current.waits?.filter(
      (w) =>
        !(
          w.callId &&
          w.callId === event.data.toolUseId &&
          w.agentId === event.agentId
        ),
    );
    if (
      !remaining ||
      remaining.length === current.waits!.length ||
      Date.parse(event.occurredAt) < Date.parse(current.at)
    )
      return current;
    return {
      ...current,
      state: stateFromWaits(remaining),
      waits: remaining,
      at: event.occurredAt,
      observedAt: event.observedAt,
      evidence: "inferred" as const,
    };
  }
  // Also protects stored legacy PostToolUse events that had been normalized to
  // turn_resumed before call correlation existed.
  if (
    waiting &&
    event.kind === "turn_resumed" &&
    event.data.hookEvent === "PostToolUse"
  )
    return current;
  const map: Record<string, State> = {
    turn_started: "running",
    turn_completed: "completed",
    turn_failed: "failed",
    turn_cancelled: "cancelled",
    waiting_user: "waiting_user",
    waiting_approval: "waiting_approval",
    turn_resumed: "running",
    agent_started: "running",
    agent_stopped: "unknown",
    turn_stopped: "unknown",
    session_ended: "unknown",
  };
  const activity = [
    "tool_started",
    "tool_activity",
    "tool_finished",
    "agent_message",
  ].includes(event.kind);
  // Work in the known running turn is fresh evidence. Usage, receipt time and
  // callbacks from other turns cannot serve as a heartbeat or reopen a turn.
  if (
    activity &&
    (current.state !== "running" ||
      !event.turnId ||
      event.turnId !== current.turnId)
  )
    return current;
  const state = activity ? "running" : map[event.kind];
  if (!state || event.data.runtimeScope === "independent-app-server")
    return current;
  const time = Date.parse(event.occurredAt);
  if (!Number.isFinite(time)) return current;
  const sameTurn = !!event.turnId && event.turnId === current.turnId;
  const newTurn =
    !!event.turnId &&
    event.turnId !== current.turnId &&
    event.kind === "turn_started";
  // A final fact about a turn is not undone by a later callback or duplicate start.
  if (
    terminal.has(current.state) &&
    current.evidence === "confirmed" &&
    !newTurn
  ) {
    if (!sameTurn || event.evidence !== "confirmed" || !terminal.has(state))
      return current;
  }
  if (
    event.turnId &&
    current.turnId &&
    event.turnId !== current.turnId &&
    event.kind !== "turn_started"
  )
    return current;
  // A confirmed outcome can arrive after an inferred callback with a later observation
  // clock. Its turn identity gives precedence; arrival time never creates a new turn.
  const authoritativeTerminal =
    sameTurn &&
    terminal.has(state) &&
    event.evidence === "confirmed" &&
    !terminal.has(current.state);
  if (!authoritativeTerminal && time < Date.parse(current.at)) return current;
  if (time === Date.parse(current.at)) {
    const rank = { unknown: 0, inferred: 1, confirmed: 2 };
    if (rank[event.evidence] < rank[current.evidence] && !newTurn)
      return current;
    if (terminal.has(current.state) && !terminal.has(state) && !newTurn)
      return current;
  }
  const waits =
    state === "waiting_user" || state === "waiting_approval"
      ? [
          ...(sameTurn ? (current.waits ?? []) : []),
          {
            id: event.id,
            callId:
              event.data.hookEvent === "PreToolUse"
                ? (event.data.toolUseId ?? null)
                : null,
            agentId: event.agentId,
            state,
          },
        ]
      : undefined;
  return {
    // Adding and resolving waits use the same priority. A new input question
    // cannot hide an unresolved permission request in this turn.
    state: waits ? stateFromWaits(waits) : state,
    turnId: event.turnId ?? current.turnId,
    at: event.occurredAt,
    evidence: activity ? ("inferred" as const) : event.evidence,
    observedAt: event.observedAt,
    ...(waits ? { waits } : {}),
  };
}
export { reconcileUsage } from "./usage.js";
import { reconcileUsage } from "./usage.js";
export function usageFromEvents(events: Event[]) {
  const { usage, uncertain, corrections } = reconcileUsage(events);
  return { usage, uncertain, corrections };
}
export function usagePoints(events: Event[]) {
  return reconcileUsage(events).points;
}
