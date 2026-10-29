import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { hash, type Event } from "../core/model.js";
import { importDatabaseMetadata } from "../collector/database.js";

function fixture(t: any, schema?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "aiwm-dbmetadata-"));
  const source = path.join(root, "source");
  mkdirSync(source);
  const file = path.join(source, "state_5.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    schema ??
      `CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,cwd TEXT,model TEXT,created_at INTEGER,updated_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,creator_account_id TEXT,tokens_used INTEGER,archived INTEGER,status TEXT,first_user_message TEXT);
CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);`,
  );
  const store = new Store(path.join(root, "monitor"));
  store.setSetting("deviceId", "test-device");
  t.after(() => {
    store.close();
    try {
      db.close();
    } catch {}
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
      throw Error("unsafe test cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, file, db, store };
}
function row(
  db: DatabaseSync,
  id: string,
  extra: {
    account?: string;
    title?: string;
    created?: number;
    updated?: number;
    tokens?: number;
    status?: string;
  } = {},
) {
  db.prepare(
    "INSERT INTO threads(id,title,cwd,model,created_at,updated_at,creator_account_id,tokens_used,archived,status,first_user_message) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    extra.title ?? "历史 " + id,
    "C:\\sample\\project",
    "model-fixture",
    extra.created ?? 1700000000,
    extra.updated ?? 1700100000,
    extra.account ?? null,
    extra.tokens ?? 99999,
    1,
    extra.status ?? "completed",
    "SECRET BODY MUST NOT IMPORT",
  );
}
function events(store: Store) {
  return store.db
    .prepare("SELECT json FROM events")
    .all()
    .map((r) => JSON.parse(String(r.json)) as Event);
}

test("metadata imports unknown state with explicit missing usage; ignores cumulative tokens/status/body and preserves source bytes", (t) => {
  const { store, source, file, db } = fixture(t);
  row(db, "thread-a", { account: "stable-creator" });
  const before = hash(readFileSync(file).toString("base64"));
  assert.equal(
    importDatabaseMetadata(store, source, "same-source", "windows"),
    1,
  );
  const [e] = events(store);
  assert.equal(e!.accountId, "codex:" + hash("stable-creator"));
  assert.equal(e!.sourceId, "same-source");
  assert.equal(e!.deviceId, "test-device");
  assert.equal(e!.environmentId, "windows");
  assert.equal(e!.data.usageUnavailable, true);
  assert.equal(e!.data.sourceKind, "database");
  assert.equal(e!.kind, "session_meta");
  assert.equal(e!.data.model, "model-fixture");
  assert.ok(!JSON.stringify(e).includes("SECRET BODY"));
  assert.ok(!JSON.stringify(e).includes("99999"));
  assert.ok(!Object.hasOwn(e!.data, "status"));
  assert.ok(!Object.hasOwn(e!.data, "archived"));
  assert.equal(
    importDatabaseMetadata(store, source, "same-source", "windows"),
    0,
  );
  assert.equal(hash(readFileSync(file).toString("base64")), before);
  store.projectDirty();
  assert.equal(
    store.sessions(new URLSearchParams()).items[0]!.state,
    "unknown",
  );
});
test("sparse schema degrades identity, timestamps and model rather than reading unknown columns", (t) => {
  const { store, source, db } = fixture(
    t,
    "CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT)",
  );
  db.prepare("INSERT INTO threads VALUES(?,?)").run("minimal", "minimal title");
  assert.equal(importDatabaseMetadata(store, source, "source", "env"), 1);
  const [e] = events(store);
  assert.equal(e!.accountId, null);
  assert.equal(e!.data.model, "未知");
  assert.equal(e!.data.timestampUnavailable, true);
  assert.equal(e!.data.parentId, null);
  assert.equal(e!.data.historyAvailable, false);
});
test("pending JSONL event and existing session metadata are never overwritten", (t) => {
  const { store, source, db } = fixture(t);
  row(db, "same-id", { title: "DATABASE TITLE" });
  const e: Event = {
    id: "jsonl-event",
    upstreamId: null,
    provider: "codex",
    deviceId: "device",
    environmentId: "env",
    sourceId: "source",
    sessionId: "same-id",
    turnId: null,
    agentId: "same-id",
    accountId: null,
    projectId: "unknown",
    kind: "session_meta",
    occurredAt: "2026-10-26T00:00:00Z",
    observedAt: "2026-10-26T00:00:00Z",
    receivedAt: "2026-10-26T00:00:00Z",
    sequence: 0,
    schemaVersion: 2,
    evidence: "confirmed",
    data: { title: "JSONL TITLE" },
  };
  store.insert(e);
  assert.equal(importDatabaseMetadata(store, source, "source", "env"), 0);
  store.projectDirty();
  assert.equal(importDatabaseMetadata(store, source, "source", "env"), 0);
  assert.equal(
    store.sessions(new URLSearchParams()).items[0]!.title,
    "JSONL TITLE",
  );
  assert.equal(events(store).length, 1);
});
test("explicit spawn descendants import while conflicting parents and cycles remain unknown", (t) => {
  const { store, source, db } = fixture(t);
  for (const id of [
    "root",
    "child",
    "grandchild",
    "ambiguous",
    "cycle-a",
    "cycle-b",
  ])
    row(db, id);
  const insert = db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)");
  for (const [parent, child] of [
    ["root", "child"],
    ["child", "grandchild"],
    ["root", "ambiguous"],
    ["child", "ambiguous"],
    ["cycle-a", "cycle-b"],
    ["cycle-b", "cycle-a"],
  ])
    insert.run(parent!, child!, "running");
  assert.equal(importDatabaseMetadata(store, source, "source", "env"), 6);
  const byId = new Map(events(store).map((e) => [e.sessionId, e]));
  assert.equal(byId.get("grandchild")!.data.parentId, "child");
  assert.equal(byId.get("grandchild")!.data.relation, "spawn");
  assert.equal(byId.get("ambiguous")!.data.parentId, null);
  assert.equal(byId.get("ambiguous")!.data.relationAmbiguous, true);
  assert.equal(byId.get("cycle-a")!.data.parentId, null);
  assert.equal(byId.get("cycle-b")!.data.parentId, null);
  assert.ok(events(store).every((e) => e.kind === "session_meta"));
});
test("read-only transaction sees committed WAL rows without copying or checkpointing source", (t) => {
  const { store, source, file, db } = fixture(t);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  row(db, "wal-committed");
  const walBefore = hash(readFileSync(file + "-wal").toString("base64"));
  const mainBefore = hash(readFileSync(file).toString("base64"));
  assert.equal(importDatabaseMetadata(store, source, "source", "env"), 1);
  assert.equal(events(store)[0]!.sessionId, "wal-committed");
  assert.equal(hash(readFileSync(file + "-wal").toString("base64")), walBefore);
  assert.equal(hash(readFileSync(file).toString("base64")), mainBefore);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM threads").get() as any).n,
    1,
  );
});
test("missing or corrupt source returns sanitized status and does not crash collector", (t) => {
  const { store, source, db } = fixture(t);
  db.close();
  const missing = path.join(source, "missing");
  assert.equal(
    importDatabaseMetadata(store, missing, "missing-source", "env"),
    0,
  );
  writeFileSync(
    path.join(source, "state_5.sqlite"),
    "not a sqlite database SECRET",
  );
  assert.equal(importDatabaseMetadata(store, source, "bad-source", "env"), 0);
  const setting = store.getSetting<any>(
    "databaseImport:" + hash("bad-source"),
    {},
  );
  assert.equal(setting.status, "unavailable");
  assert.ok(!JSON.stringify(setting).includes("SECRET"));
  assert.ok(!JSON.stringify(setting).includes(source));
});
