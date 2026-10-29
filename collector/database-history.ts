import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { hash, type Event } from "../core/model.js";

export type DatabaseHistoryResult = {
  events: Event[];
  available: boolean;
  limitation?: string;
};
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const isName = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_./:-]{0,100}$/.test(v);
const columns = (db: DatabaseSync, table: "thread_items" | "thread_turns") =>
  new Set(
    db
      .prepare('PRAGMA table_info("' + table + '")')
      .all()
      .map((r) => String(r.name)),
  );
const textLimit = 50_000;
const statusValues = new Set([
  "inProgress",
  "in_progress",
  "completed",
  "failed",
  "declined",
  "interrupted",
  "pending",
  "running",
  "cancelled",
  "canceled",
]);
function cursor(ordinal: number, itemId: string): string {
  return (
    "db:" +
    Buffer.from(JSON.stringify([ordinal, itemId]), "utf8").toString("base64url")
  );
}
function parseCursor(value: string): [number, string] | null {
  if (!value.startsWith("db:") || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(3), "base64url").toString("utf8"),
    );
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === "string" &&
      parsed[1].length <= 1024
      ? (parsed as [number, string])
      : null;
  } catch {
    return null;
  }
}
function timestamp(value: unknown, seconds = false): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(seconds ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function messageText(
  item: Record<string, unknown>,
  type: string,
): { text?: string; truncated?: boolean } {
  let text: string | undefined;
  if (type === "agentMessage" && typeof item.text === "string")
    text = item.text;
  if (type === "userMessage" && Array.isArray(item.content)) {
    text = item.content
      .flatMap((part) => {
        const p = object(part);
        return p &&
          ["text", "input_text", "output_text"].includes(String(p.type)) &&
          typeof p.text === "string"
          ? [p.text]
          : [];
      })
      .join("\n");
  }
  if (text === undefined) return {};
  return { text: text.slice(0, textLimit), truncated: text.length > textLimit };
}
/**
 * On-demand local plaintext replay. No source writes, token accounting or state
 * projection. Never persists returned text in the monitor event/sync databases.
 * Callers must keep the endpoint local/authenticated and must not upload results.
 * Each returned event's data.historyCursor can be sent as before; use the first
 * (oldest) event's cursor for the next older page. Timestamps are not cursors.
 */
export function readDatabaseHistory(
  sourceRoot: string,
  threadId: string,
  before?: string | null,
): DatabaseHistoryResult {
  const fail = (limitation: string): DatabaseHistoryResult => ({
    events: [],
    available: false,
    limitation,
  });
  if (typeof threadId !== "string" || !threadId || threadId.length > 1024)
    return fail("会话标识无效");
  const boundary = before ? parseCursor(before) : null;
  if (before && !boundary)
    return fail("数据库历史分页游标无效；请重新打开会话");
  const file = path.join(sourceRoot, "thread_history_1.sqlite");
  if (!existsSync(file))
    return fail("本机没有可读历史正文数据库，仅能展示会话元信息");
  if (existsSync(file + "-wal") && !existsSync(file + "-shm"))
    return fail("历史数据库 WAL 索引不可用；未复制或修复源文件");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const itemColumns = columns(db, "thread_items");
    if (
      ![
        "thread_id",
        "turn_id",
        "item_id",
        "rollout_ordinal",
        "item_json",
        "item_type",
      ].every((k) => itemColumns.has(k))
    )
      return fail("历史数据库格式尚未支持；未尝试修改或解密");
    const turnColumns = columns(db, "thread_turns");
    const joinTurns = ["thread_id", "turn_id", "started_at"].every((k) =>
      turnColumns.has(k),
    );
    const created = itemColumns.has("created_at_ms")
      ? "i.created_at_ms"
      : "NULL";
    const started = itemColumns.has("started_at_ms")
      ? "i.started_at_ms"
      : "NULL";
    const joinSql = joinTurns
      ? " LEFT JOIN thread_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id"
      : "";
    const turnStarted = joinTurns ? "t.started_at" : "NULL";
    const hasHistory = !!db
      .prepare("SELECT 1 FROM thread_items WHERE thread_id=? LIMIT 1")
      .get(threadId);
    if (!hasHistory) return fail("该会话只有元信息，历史数据库未提供正文记录");
    const where = boundary
      ? " AND (i.rollout_ordinal<? OR (i.rollout_ordinal=? AND i.item_id<?))"
      : "";
    const query = `SELECT i.item_id,i.turn_id,i.rollout_ordinal,i.item_type,
      CASE WHEN length(i.item_json)<=1048576 THEN i.item_json ELSE NULL END AS item_json,
      ${created} AS created_at_ms,${started} AS started_at_ms,${turnStarted} AS turn_started_at
      FROM thread_items i${joinSql} WHERE i.thread_id=?${where}
      ORDER BY i.rollout_ordinal DESC,i.item_id DESC LIMIT 200`;
    const args: (string | number)[] = boundary
      ? [threadId, boundary[0], boundary[0], boundary[1]]
      : [threadId];
    const events: Event[] = [];
    let malformed = 0;
    let readable = 0;
    const observedAt = new Date().toISOString();
    for (const row of db.prepare(query).iterate(...args)) {
      const itemId = typeof row.item_id === "string" ? row.item_id : null;
      const ordinal =
        typeof row.rollout_ordinal === "number" &&
        Number.isSafeInteger(row.rollout_ordinal)
          ? row.rollout_ordinal
          : null;
      if (!itemId || ordinal === null) {
        malformed++;
        continue;
      }
      let item: Record<string, unknown> | null = null;
      try {
        if (typeof row.item_json === "string")
          item = object(JSON.parse(row.item_json));
      } catch {
        /* Do not decode encrypted or malformed material. */
      }
      const type = isName(item?.type)
        ? item.type
        : isName(row.item_type)
          ? row.item_type
          : "unknown";
      const hasEncrypted =
        !!item &&
        Object.keys(item).some((k) => /encrypted|ciphertext/i.test(k));
      const data: Record<string, unknown> = {
        sourceKind: "database-history",
        localOnly: true,
        readOnlyReplay: true,
        type,
        historyCursor: cursor(ordinal, itemId),
        usageUnavailable: true,
      };
      let kind = "tool_activity";
      if (item && !hasEncrypted) {
        readable++;
        if (type === "userMessage") {
          kind = "user_message";
          Object.assign(data, messageText(item, type));
        } else if (type === "agentMessage") {
          kind = "agent_message";
          Object.assign(data, messageText(item, type));
        } else {
          // Commands, arguments, tool results/errors, paths and reasoning content
          // are deliberately excluded from this default metadata rendering.
          if (typeof item.status === "string" && statusValues.has(item.status))
            data.status = item.status;
          if (type === "mcpToolCall" && isName(item.tool))
            data.name = item.tool;
          else data.name = type;
        }
      } else {
        malformed++;
        kind = "diagnostic";
        data.contentUnavailable = true;
        data.reason = hasEncrypted
          ? "encrypted_not_decoded"
          : "unparseable_or_oversize";
      }
      const occurredAt =
        timestamp(row.started_at_ms) ??
        timestamp(row.created_at_ms) ??
        timestamp(row.turn_started_at, true) ??
        "1970-01-01T00:00:00.000Z";
      events.push({
        id: "dbitem:" + hash("codex:" + threadId + ":" + itemId),
        upstreamId: itemId,
        provider: "codex",
        deviceId: "unknown",
        environmentId: "unknown",
        sourceId: "codex-db-history:" + hash(path.resolve(sourceRoot)),
        sessionId: threadId,
        turnId: typeof row.turn_id === "string" ? row.turn_id : null,
        agentId: threadId,
        accountId: null,
        projectId: "unknown",
        kind,
        occurredAt,
        observedAt,
        receivedAt: observedAt,
        sequence: ordinal,
        schemaVersion: 2,
        evidence: item && !hasEncrypted ? "confirmed" : "unknown",
        data,
      });
    }
    db.exec("ROLLBACK");
    events.reverse();
    const unavailable = events.length > 0 && readable === 0;
    return {
      events,
      available: !unavailable,
      limitation: unavailable
        ? "本页记录无法作为明文解析或包含加密内容；未尝试解密"
        : "本机按需分页回放（最多200项）；仅消息正文和工具元信息，不含工具参数/输出、用量或实时状态" +
          (malformed ? "；部分记录不可读" : ""),
    };
  } catch {
    return fail(
      "历史数据库当前不可只读访问或格式不兼容；未修复、复制或写入源库",
    );
  } finally {
    if (db)
      try {
        db.close();
      } catch {
        /* no private error text */
      }
  }
}
