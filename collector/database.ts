import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { Store } from "../core/store.js";
import { hash, type Event } from "../core/model.js";

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length ? v : null;
function time(value: unknown, milliseconds: boolean): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(milliseconds ? value : value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function columns(
  db: DatabaseSync,
  table: "threads" | "thread_spawn_edges",
): Set<string> {
  return new Set(
    db
      .prepare('PRAGMA table_info("' + table + '")')
      .all()
      .map((r) => String(r.name)),
  );
}
/**
 * Read metadata only from an existing Codex state DB, never create/migrate/copy it.
 * No auth/config tables, message previews, task status or cumulative token fields.
 * The returned count is newly imported sessions; a zero may also mean unavailable,
 * whose sanitized reason is saved to databaseImport:<source hash> settings.
 */
export function importDatabaseMetadata(
  store: Store,
  sourceRoot: string,
  sourceId: string,
  environmentId: string,
): number {
  const databasePath = path.join(sourceRoot, "state_5.sqlite");
  const settingKey = "databaseImport:" + hash(sourceId);
  const observedAt = new Date().toISOString();
  const report = (status: string, extra: Record<string, unknown> = {}) => {
    store.setSetting(settingKey, {
      status,
      observedAt,
      sourceId,
      database: "state_5.sqlite",
      ...extra,
    });
  };
  if (!existsSync(databasePath)) {
    report("missing");
    return 0;
  }
  if (existsSync(databasePath + "-wal") && !existsSync(databasePath + "-shm")) {
    report("unavailable", { reason: "wal_index_missing_no_copy_attempted" });
    return 0;
  }
  let source: DatabaseSync | undefined;
  let stage = "open";
  try {
    source = new DatabaseSync(databasePath, { readOnly: true });
    source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    stage = "schema";
    const threadColumns = columns(source, "threads");
    if (!threadColumns.has("id")) throw new Error("unsupported_threads_schema");
    // Fixed allowlist, never SELECT *. Optional fields degrade to null.
    const fields = [
      "id",
      "title",
      "name",
      "cwd",
      "model",
      "created_at",
      "updated_at",
      "created_at_ms",
      "updated_at_ms",
      "creator_account_id",
    ] as const;
    const projection = fields
      .map((name) =>
        threadColumns.has(name) ? '"' + name + '"' : 'NULL AS "' + name + '"',
      )
      .join(",");
    const edgeColumns = columns(source, "thread_spawn_edges");
    const candidates = new Map<string, Set<string>>();
    if (
      edgeColumns.has("parent_thread_id") &&
      edgeColumns.has("child_thread_id")
    ) {
      for (const edge of source
        .prepare(
          "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges",
        )
        .iterate()) {
        const parent = text(edge.parent_thread_id);
        const child = text(edge.child_thread_id);
        if (!parent || !child || parent === child) continue;
        const parents = candidates.get(child) ?? new Set<string>();
        parents.add(parent);
        candidates.set(child, parents);
      }
    }
    const parentMap = new Map<string, string>();
    for (const [child, parents] of candidates)
      if (parents.size === 1) parentMap.set(child, [...parents][0]!);
    const unsafeRelations = new Set<string>();
    // Defensive against corrupted/ambiguous source edges; never invent ancestry.
    for (const child of parentMap.keys()) {
      const visited = new Set<string>();
      let node: string | undefined = child;
      while (node && parentMap.has(node)) {
        if (visited.has(node)) {
          for (const seen of visited) unsafeRelations.add(seen);
          break;
        }
        visited.add(node);
        node = parentMap.get(node);
      }
    }
    stage = "read";
    const deviceId = store.getSetting<string>("deviceId", "unknown");
    const pending: Event[] = [];
    let examined = 0;
    let existing = 0;
    let invalid = 0;
    const hasSession = store.db.prepare("SELECT 1 FROM sessions WHERE id=?");
    const hasEvents = store.db.prepare(
      "SELECT 1 FROM events WHERE session_id=? LIMIT 1",
    );
    for (const row of source
      .prepare("SELECT " + projection + " FROM threads")
      .iterate()) {
      examined++;
      const id = text(row.id);
      if (!id) {
        invalid++;
        continue;
      }
      if (hasSession.get(id) || hasEvents.get(id)) {
        existing++;
        continue;
      }
      const createdAt =
        time(row.created_at_ms, true) ?? time(row.created_at, false);
      const updatedAt =
        time(row.updated_at_ms, true) ??
        time(row.updated_at, false) ??
        createdAt;
      // Unknown source timestamps stay explicitly unknown; no "now" running evidence.
      const at = createdAt ?? updatedAt ?? "1970-01-01T00:00:00.000Z";
      const cwd = text(row.cwd);
      const normalized = cwd ? path.normalize(cwd) : "";
      const account = text(row.creator_account_id);
      const parentId = unsafeRelations.has(id)
        ? null
        : (parentMap.get(id) ?? null);
      const event: Event = {
        id: "dbmeta:" + hash("codex:" + sourceId + ":" + id),
        upstreamId: null,
        provider: "codex",
        deviceId,
        environmentId,
        sourceId,
        sessionId: id,
        turnId: null,
        agentId: id,
        accountId: account ? "codex:" + hash(account) : null,
        projectId: normalized
          ? "project:" + hash(environmentId + ":" + normalized)
          : "unknown",
        kind: "session_meta",
        occurredAt: at,
        observedAt,
        receivedAt: observedAt,
        sequence: 0,
        schemaVersion: 2,
        evidence: "confirmed",
        data: {
          sourceKind: "database",
          metadataOnly: true,
          title: text(row.name) ?? text(row.title) ?? "Codex 历史会话",
          projectLabel: normalized ? path.basename(normalized) : "未知项目",
          projectPath: normalized,
          model: text(row.model) ?? "未知",
          parentId,
          relation: parentId ? "spawn" : null,
          relationAmbiguous:
            unsafeRelations.has(id) || (candidates.get(id)?.size ?? 0) > 1,
          accountEvidence: account ? "database_creator_account_id" : "unknown",
          databaseCreatedAt: createdAt,
          databaseUpdatedAt: updatedAt,
          timestampUnavailable: !createdAt && !updatedAt,
          usageUnavailable: true,
          historyAvailable: false,
          limitation:
            "仅数据库会话元信息；未读取消息正文，不能回放或重建用量；状态未知",
        },
      };
      pending.push(event);
    }
    source.exec("ROLLBACK");
    source.close();
    source = undefined;
    stage = "import";
    let imported = 0;
    store.transaction(() => {
      for (const event of pending) {
        // Re-check at write time; preserve any JSONL event imported meanwhile.
        if (hasSession.get(event.sessionId) || hasEvents.get(event.sessionId))
          continue;
        if (store.insert(event)) imported++;
      }
      report("verified_read_only_metadata", {
        examined,
        existing,
        imported,
        invalid,
        schemaAccountId: threadColumns.has("creator_account_id"),
        replay: "unavailable",
        usage: "unavailable",
      });
    });
    return imported;
  } catch (error) {
    const e = error as { code?: string; errcode?: number };
    report("unavailable", {
      stage,
      errorCode: e.code ?? "UNSUPPORTED_OR_UNAVAILABLE",
      sqliteCode: e.errcode ?? null,
    });
    return 0;
  } finally {
    if (source) {
      try {
        source.close();
      } catch {
        /* no raw error text or source writes */
      }
    }
  }
}
