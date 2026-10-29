import fs from "node:fs";
import path from "node:path";
import { Store } from "../core/store.js";
import { hash, Event } from "../core/model.js";
import { hookConfiguration, installationStatus } from "./hook-install.js";
export function migrateHookSwitch(store: Store) {
  if (store.getSetting("hookSwitchVersion", 0) >= 2) return;
  // Queue-only consent from 0.1.0 does not authorize external config writes.
  if (!fs.existsSync(path.join(store.dir, "hook-install.json"))) {
    const preferences = store.getSetting<any>("preferences", {});
    store.setSetting("preferences", { ...preferences, hooksEnabled: false });
  }
  store.setSetting("hookSwitchVersion", 2);
}
export function hookPreview(
  dataDir: string,
  enabled = false,
  lastEvent?: string,
) {
  return {
    enabled,
    ...installationStatus(dataDir, enabled, lastEvent),
    preview: JSON.stringify(hookConfiguration(dataDir), null, 2),
    explanation:
      "开启时自动备份并合并本产品配置，关闭时自动移除本产品条目。首次仍需在 Codex 中确认信任；未收到事件前不宣称已生效。脚本只记录本机状态，不联网、不保存对话内容。",
    queue: path.join(dataDir, "hook-queue.jsonl"),
  };
}
type HookRecord = {
  schemaVersion: number;
  kind: string;
  sessionId: string;
  turnId: string | null;
  agentId: string | null;
  observedAt: string;
  waitsForUser?: boolean;
  toolUseId?: string | null;
};
const supported = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
]);
function hookRecord(raw: string): HookRecord | null {
  try {
    const p = JSON.parse(raw);
    if (
      ![1, 2].includes(p.schemaVersion) ||
      !supported.has(p.kind) ||
      typeof p.sessionId !== "string" ||
      !p.sessionId ||
      p.sessionId.length > 200 ||
      !Number.isFinite(Date.parse(p.observedAt))
    )
      return null;
    return {
      schemaVersion: p.schemaVersion,
      kind: p.kind,
      sessionId: p.sessionId,
      turnId: typeof p.turnId === "string" ? p.turnId.slice(0, 200) : null,
      agentId: typeof p.agentId === "string" ? p.agentId.slice(0, 200) : null,
      observedAt: new Date(p.observedAt).toISOString(),
      waitsForUser: p.waitsForUser === true,
      toolUseId:
        ["PreToolUse", "PostToolUse"].includes(p.kind) &&
        typeof p.toolUseId === "string" &&
        p.toolUseId.length > 0 &&
        p.toolUseId.length <= 200
          ? p.toolUseId
          : null,
    };
  } catch {
    return null;
  }
}
export function readHookQueue(store: Store) {
  if (!store.getSetting<any>("preferences", {}).hooksEnabled) return 0;
  // Cursor and durable inbox are committed together. Unindexed sessions never lose callbacks.
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS pending_hooks(id TEXT PRIMARY KEY,json TEXT NOT NULL,received_at TEXT NOT NULL,sequence INTEGER NOT NULL,last_attempt_at TEXT NOT NULL DEFAULT '')",
  );
  const file = path.join(store.dir, "hook-queue.jsonl");
  let count = 0;
  let latestObservedAt =
    store.getSetting<string | null>("lastHookObservedAt", null) ?? "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    let offset = store.getSetting("hookQueueOffset", 0);
    if (offset > size) offset = 0;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(1024 * 1024, size - offset));
      fs.readSync(fd, buf, 0, buf.length, offset);
      const end = buf.lastIndexOf(10);
      if (end >= 0) {
        const receivedAt = new Date().toISOString();
        store.transaction(() => {
          let sequence = offset;
          let rejected = 0;
          for (const line of buf
            .subarray(0, end)
            .toString("utf8")
            .split("\n")) {
            const p = hookRecord(line);
            if (p)
              store.db
                .prepare(
                  "INSERT OR IGNORE INTO pending_hooks(id,json,received_at,sequence) VALUES(?,?,?,?)",
                )
                .run(
                  "hook:" + hash(line),
                  JSON.stringify(p),
                  receivedAt,
                  sequence,
                );
            else if (line.trim()) rejected++;
            sequence += Buffer.byteLength(line) + 1;
          }
          if (rejected)
            store.setSetting(
              "hookRejectedCount",
              store.getSetting("hookRejectedCount", 0) + rejected,
            );
          store.setSetting("hookQueueOffset", offset + end + 1);
          store.setSetting("hookQueueError", null);
        });
      } else if (buf.length === 1024 * 1024) {
        store.setSetting(
          "hookQueueError",
          "Hook 队列单行超过安全上限，原始数据已保留；请检查高级诊断",
        );
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const candidates = store.db
    .prepare(
      "SELECT * FROM pending_hooks ORDER BY last_attempt_at,id LIMIT 1000",
    )
    .all() as any[];
  const now = new Date().toISOString();
  store.transaction(() => {
    for (const row of candidates) {
      const p = JSON.parse(row.json) as HookRecord;
      const subagent = p.kind === "SubagentStart" || p.kind === "SubagentStop";
      if (
        store.db
          .prepare(
            "SELECT 1 FROM tombstones WHERE session_id=? OR session_id=?",
          )
          .get(p.sessionId, subagent ? p.agentId : p.sessionId)
      ) {
        store.db.prepare("DELETE FROM pending_hooks WHERE id=?").run(row.id);
        continue;
      }
      const parent = store.db
        .prepare("SELECT * FROM sessions WHERE id=?")
        .get(p.sessionId) as any;
      let known = parent;
      if (subagent && p.agentId) {
        known = store.db
          .prepare("SELECT * FROM sessions WHERE id=?")
          .get(p.agentId) as any;
        if (!known) {
          const aliases = store.db
            .prepare(
              "SELECT DISTINCT session_id FROM events WHERE kind='session_meta' AND json_extract(json,'$.data.agentId')=? LIMIT 2",
            )
            .all(p.agentId) as any[];
          if (aliases.length === 1)
            known = store.db
              .prepare("SELECT * FROM sessions WHERE id=?")
              .get(aliases[0].session_id) as any;
        }
      }
      if (
        !known ||
        !parent ||
        (subagent &&
          (!p.agentId ||
            known.id === parent.id ||
            (known.parent_id && known.parent_id !== parent.id) ||
            (known.relation && known.relation !== "spawn")))
      ) {
        store.db
          .prepare("UPDATE pending_hooks SET last_attempt_at=? WHERE id=?")
          .run(now, row.id);
        continue;
      }
      // Subagent hook turn_id belongs to the parent callback context; do not relabel it
      // as a child turn. A child's own turn events remain the terminal authority.
      let kind = "hook_observation";
      const turnId = subagent ? null : p.turnId;
      if (p.kind === "SubagentStart") kind = "agent_started";
      if (p.kind === "SubagentStop") kind = "agent_stopped";
      if (p.kind === "SessionEnd") kind = "session_ended";
      if (turnId) {
        if (p.kind === "UserPromptSubmit") kind = "turn_started";
        if (p.kind === "PermissionRequest") kind = "waiting_approval";
        if (p.kind === "PreToolUse" && p.waitsForUser) kind = "waiting_user";
        if (p.kind === "PostToolUse") kind = "tool_finished";
        if (p.kind === "Stop") kind = "turn_stopped";
        if (p.kind === "Interrupt") kind = "turn_cancelled";
      }
      const e: Event = {
        id: row.id,
        upstreamId: null,
        provider: "codex",
        deviceId: store.getSetting("deviceId", "unknown"),
        environmentId: store.getSetting("environmentId", "unknown"),
        sourceId: known.source_id,
        sessionId: known.id,
        turnId,
        agentId: p.agentId || known.id,
        accountId: known.account_id,
        projectId: known.project_id,
        kind,
        occurredAt: p.observedAt,
        observedAt: p.observedAt,
        receivedAt: row.received_at,
        sequence: row.sequence,
        schemaVersion: 3,
        evidence: p.kind === "Interrupt" && turnId ? "confirmed" : "inferred",
        data: {
          hookEvent: p.kind,
          toolUseId: p.toolUseId ?? null,
          evidenceSource: "opt-in-local-hook",
          model: known.model,
          accountEvidence: "session_creator_only",
          agentIdentityBasis: p.agentId ? "hook_agent_id" : "session_scope",
          timeBasis: "hook_callback_observed",
          upstreamOccurredAt: null,
          parentId: subagent ? parent.id : null,
          parentTurnId: subagent ? p.turnId : null,
          relation: subagent ? "spawn" : null,
          relationEvidence: subagent ? "hook_contract" : null,
        },
      };
      if (store.insert(e)) {
        count++;
        if (p.observedAt > latestObservedAt) latestObservedAt = p.observedAt;
      }
      store.db.prepare("DELETE FROM pending_hooks WHERE id=?").run(row.id);
    }
    store.setSetting(
      "hookPendingCount",
      (store.db.prepare("SELECT count(*) n FROM pending_hooks").get() as any).n,
    );
    if (count) {
      store.setSetting("lastHookObservedAt", latestObservedAt);
      store.setSetting("lastHookReceivedAt", now);
    }
  });
  return count;
}
