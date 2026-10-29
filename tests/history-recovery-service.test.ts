import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "../core/store.js";
import { Event } from "../core/model.js";
import { HistoryRecovery } from "../server/history-recovery.js";

// Keep paths below Windows SQLite's filename limit, including rehearsal nesting.
const root = path.join(os.tmpdir(), "hrs-" + randomUUID().slice(0, 8));
fs.mkdirSync(root, { recursive: true });
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function event(id: string, sessionId = "historical", metadata = false): Event {
  const at = "2026-10-01T00:00:00.000Z";
  return {
    id,
    kind: metadata ? "session_meta" : "usage_response",
    sessionId,
    sourceId: "source-" + id,
    deviceId: "device-" + id,
    environmentId: "environment-" + id,
    agentId: sessionId,
    provider: "codex",
    turnId: "turn",
    accountId: null,
    projectId: "project",
    upstreamId: metadata ? null : id,
    sequence: 1,
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    evidence: "confirmed",
    schemaVersion: 2,
    data: metadata
      ? { title: sessionId, metadataOnly: true, sourceKind: "database" }
      : { usage: { input: 100, output: 20 } },
  };
}
function rows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}
function state(db: DatabaseSync) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, rows(db, name)]));
}
async function setup(
  name: string,
  pauseAction?: (store: Store) => void | Promise<void>,
) {
  const shortName = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const dir = path.join(root, shortName);
  const store = new Store(dir);
  store.setSetting("deviceId", "current-device");
  store.setSetting("environmentId", "current-environment");
  store.setSetting("sourceConfigs", [
    { id: "current-source", path: "/fixture-only" },
  ]);
  store.setSetting("preferences", {
    hooksEnabled: false,
    notifications: { enabled: true },
  });
  store.setSetting(
    "opaqueCredentialFixture",
    (store as any).credentials.seal({ fixture: "must remain byte identical" }),
  );
  store.db
    .prepare("INSERT INTO cursors VALUES(?,?,?,?)")
    .run("/fixture-log", 913, "signature", '{"turn":1}');
  store.db
    .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
    .run("my-account", "manual association", "codex", "confirmed");
  store.db
    .prepare("INSERT INTO bindings VALUES(?,?,?,?,?,?,?)")
    .run(
      "my-binding",
      "my-account",
      "current-source",
      "2026-01-01",
      "2027-01-01",
      "confirmed",
      0,
    );
  store.insert(event("metadata", "historical", true));
  store.insert(event("current", "new-session"));
  store.projectDirty();
  store.db
    .prepare("UPDATE sessions SET notes=?,pinned=1 WHERE id=?")
    .run("my preserved note", "historical");
  store.db
    .prepare("INSERT INTO annotations VALUES(?,?,?)")
    .run("historical", "my preserved note", 1);
  const legacy = new Store(path.join(root, shortName + "-old"));
  legacy.insert(event("legacy"));
  legacy.projectDirty();
  legacy.db
    .prepare("INSERT INTO quotas VALUES(?,?,?,?,?,?)")
    .run(
      "old-quota",
      null,
      "pool",
      "weekly",
      "2026-10-01",
      JSON.stringify({ remaining: 45 }),
    );
  const file = "monitor-1000.sqlite";
  fs.mkdirSync(path.join(dir, "backups"));
  const source = path.join(dir, "backups", file);
  await backup(legacy.db, source);
  legacy.close();
  const lifecycle: string[] = [];
  const service = new HistoryRecovery(store, {
    pause: async () => {
      lifecycle.push("pause");
      await pauseAction?.(store);
      lifecycle.push("drained");
    },
    resume: () => lifecycle.push("resume"),
  });
  return { store, source, file, service, lifecycle };
}

test("preview is read-only; apply includes arrivals before pause, keeps current connection and protected data, imports quota history", async () => {
  const f = await setup("fresh-snapshot", (store) => {
    store.insert(event("drained", "drained-session"));
    store.projectDirty();
  });
  try {
    const db = f.store.db,
      credentials = (f.store as any).credentials;
    const protectedBefore = Object.fromEntries(
      ["settings", "cursors", "annotations", "bindings"].map((t) => [
        t,
        rows(db, t),
      ]),
    );
    const sourceBefore = hash(f.source),
      credentialBefore = hash(path.join(f.store.dir, "credential-key.local"));
    const beforePreview = state(db);
    const preview = await f.service.preview(f.file);
    assert.deepEqual(state(db), beforePreview);
    assert.deepEqual(f.lifecycle, []);
    assert.equal(preview.counts.eventsAdded, 1);
    assert.equal(preview.counts.quotasAdded, 1);
    f.store.insert(event("after-preview", "after-preview-session"));
    f.store.projectDirty();
    const result = await f.service.apply(f.file, preview.token);
    assert.deepEqual(f.lifecycle, ["pause", "drained", "resume"]);
    assert.equal(f.service.busy, false);
    assert.equal(f.store.db, db);
    assert.equal((f.store as any).credentials, credentials);
    assert.deepEqual(
      rows(db, "events")
        .map((r: any) => r.id)
        .sort(),
      ["metadata", "current", "legacy", "after-preview", "drained"].sort(),
    );
    assert.equal(
      (
        db
          .prepare("SELECT total_tokens FROM sessions WHERE id='historical'")
          .get() as any
      ).total_tokens,
      120,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(protectedBefore).map((t) => [t, rows(db, t)]),
      ),
      protectedBefore,
    );
    assert.equal(
      (
        db
          .prepare("SELECT notes FROM sessions WHERE id='historical'")
          .get() as any
      ).notes,
      "my preserved note",
    );
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM quotas WHERE id='old-quota'")
          .get() as any
      ).n,
      1,
      "reported recovered quota must exist in live DB",
    );
    assert.equal(hash(f.source), sourceBefore);
    assert.equal(
      hash(path.join(f.store.dir, "credential-key.local")),
      credentialBefore,
    );
    const saved = new DatabaseSync(
      path.join(f.store.dir, "backups", result.backup),
      { readOnly: true },
    );
    try {
      assert.equal(
        (saved.prepare("SELECT count(*) n FROM events").get() as any).n,
        4,
      );
      assert.equal(
        (
          saved
            .prepare("SELECT count(*) n FROM events WHERE id='legacy'")
            .get() as any
        ).n,
        0,
      );
    } finally {
      saved.close();
    }
  } finally {
    f.store.close();
  }
});

test("unknown, mismatched, expired and consumed previews reject without pausing", async (t) => {
  const f = await setup("tokens");
  try {
    await assert.rejects(f.service.apply(f.file, "missing"), /预览/);
    const preview = await f.service.preview(f.file);
    await assert.rejects(
      f.service.apply("monitor-1001.sqlite", preview.token),
      /预览/,
    );
    const now = Date.now();
    const clock = t.mock.method(Date, "now", () => now + 600001);
    await assert.rejects(f.service.apply(f.file, preview.token), /预览/);
    clock.mock.restore();
    assert.deepEqual(f.lifecycle, []);
    assert.equal(f.service.busy, false);
    const fresh = await f.service.preview(f.file);
    await f.service.apply(f.file, fresh.token);
    f.lifecycle.length = 0;
    await assert.rejects(f.service.apply(f.file, fresh.token), /预览/);
    assert.deepEqual(f.lifecycle, []);
  } finally {
    f.store.close();
  }
});

test("path traversal and legacy source changed after preview are refused without changing current data", async () => {
  const f = await setup("changed-input");
  try {
    await assert.rejects(f.service.preview("../monitor-1000.sqlite"), /备份/);
    const preview = await f.service.preview(f.file),
      current = state(f.store.db);
    const old = new DatabaseSync(f.source);
    old
      .prepare("UPDATE settings SET value=? WHERE key=?")
      .run(JSON.stringify("changed"), "deviceId");
    // This fixture may not contain deviceId; add a new raw setting to guarantee a changed source.
    old
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run("change-after-preview", "true");
    old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    old.close();
    await assert.rejects(
      f.service.apply(f.file, preview.token),
      /history-recovery-input-changed/,
    );
    assert.deepEqual(state(f.store.db), current);
    assert.deepEqual(f.lifecycle, ["pause", "drained", "resume"]);
    assert.equal(f.service.busy, false);
  } finally {
    f.store.close();
  }
});

test("an actual live SQLite trigger abort rolls back the entire commit and keeps the fresh backup", async () => {
  const f = await setup("commit-rollback");
  try {
    const preview = await f.service.preview(f.file),
      before = state(f.store.db);
    // TEMP trigger remains only on the live connection, so the offline rehearsal
    // succeeds before the actual apply transaction hits this failure.
    f.store.db.exec(
      "CREATE TEMP TRIGGER fail_repair BEFORE DELETE ON main.events BEGIN SELECT RAISE(ABORT,'fixture-commit-failure'); END",
    );
    await assert.rejects(
      f.service.apply(f.file, preview.token),
      /fixture-commit-failure/,
    );
    assert.deepEqual(state(f.store.db), before);
    assert.deepEqual(f.lifecycle, ["pause", "drained", "resume"]);
    assert.equal(f.service.busy, false);
    assert.equal(
      f.store.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
    );
    assert.ok(fs.readdirSync(path.join(f.store.dir, "backups")).length >= 2);
    assert.equal(
      (f.store.db.prepare("PRAGMA database_list").all() as any[]).filter((x) =>
        x.name.startsWith("recovery_"),
      ).length,
      0,
    );
  } finally {
    f.store.close();
  }
});

test("an unexpected writer after the frozen backup is retained and rejects the repair", async () => {
  const f = await setup("unexpected-writer");
  try {
    const preview = await f.service.preview(f.file);
    const commit = (f.service as any).commit.bind(f.service);
    (f.service as any).commit = (before: string, merged: string) => {
      // Deterministic concurrency seam: this is a genuine live DB write after
      // rehearsal, immediately before the service's atomic comparison/commit.
      f.store.insert(event("concurrent", "concurrent-session"));
      f.store.projectDirty();
      commit(before, merged);
    };
    await assert.rejects(
      f.service.apply(f.file, preview.token),
      /数据发生变化/,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM events WHERE id='concurrent'")
          .get() as any
      ).n,
      1,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM events WHERE id='legacy'")
          .get() as any
      ).n,
      0,
    );
    assert.deepEqual(f.lifecycle, ["pause", "drained", "resume"]);
  } finally {
    f.store.close();
  }
});

test("repeated preview/apply does not multiply history or archive evidence", async () => {
  const f = await setup("repeat");
  try {
    const first = await f.service.preview(f.file);
    await f.service.apply(f.file, first.token);
    const before = state(f.store.db);
    const second = await f.service.preview(f.file);
    const applied = await f.service.apply(f.file, second.token);
    assert.equal(applied.idempotent, true);
    assert.equal(applied.counts.eventsAdded, 0);
    assert.equal(applied.counts.quotasAdded, 0);
    assert.deepEqual(state(f.store.db), before);
  } finally {
    f.store.close();
  }
});

test("a table removed by an unexpected writer after backup rejects repair", async () => {
  const f = await setup("schema-writer");
  try {
    f.store.db.exec("DELETE FROM bindings");
    const preview = await f.service.preview(f.file);
    const commit = (f.service as any).commit.bind(f.service);
    (f.service as any).commit = (before: string, merged: string) => {
      f.store.db.exec("DROP TABLE notifications");
      commit(before, merged);
    };
    await assert.rejects(f.service.apply(f.file, preview.token), /数据发生变化|结构/);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM events WHERE id='legacy'").get() as any).n, 0);
    assert.deepEqual(f.lifecycle, ["pause", "drained", "resume"]);
  } finally { f.store.close(); }
});

test("pause failures resume safely and preview excludes concurrent operations", async () => {
  const f = await setup("pause-failed", () => {
    throw Error("fixture-pause-failed");
  });
  try {
    const pending = f.service.preview(f.file);
    await assert.rejects(f.service.preview(f.file), /进行中/);
    const preview = await pending,
      before = state(f.store.db);
    await assert.rejects(
      f.service.apply(f.file, preview.token),
      /fixture-pause-failed/,
    );
    assert.deepEqual(state(f.store.db), before);
    assert.deepEqual(f.lifecycle, ["pause", "resume"]);
    assert.equal(f.service.busy, false);
  } finally {
    f.store.close();
  }
});
