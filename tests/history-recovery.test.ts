import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "../core/store.js";
import { Event, hash } from "../core/model.js";
import {
  planHistoryRecovery,
  recoverHistory,
} from "../core/history-recovery.js";

const root = path.resolve("work", "history-recovery-tests-" + randomUUID());
fs.mkdirSync(root, { recursive: true });
function sha(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function event(
  id: string,
  kind: string,
  sourceId = "current",
  sessionId = "historical",
  n = 1,
): Event {
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
  return {
    id,
    kind,
    sourceId,
    sessionId,
    upstreamId: kind === "usage_response" ? id : null,
    deviceId: sourceId + "-device",
    environmentId: sourceId + "-environment",
    agentId: sessionId,
    provider: "codex",
    turnId: "turn",
    accountId: null,
    projectId: "project",
    sequence: n,
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    evidence: "confirmed",
    schemaVersion: 2,
    data:
      kind === "session_meta"
        ? { title: sessionId, metadataOnly: true, sourceKind: "database" }
        : { usage: { input: 100, output: 20 } },
  };
}
async function fixture(
  name: string,
  events: Event[],
  change?: (s: Store) => void,
) {
  const dir = path.join(root, name + "-live");
  const s = new Store(dir);
  s.setSetting("deviceId", name + "-device");
  s.setSetting("environmentId", name + "-environment");
  s.setSetting("sourceConfigs", [
    { id: name, path: "fixture-only", environmentId: name + "-environment" },
  ]);
  s.setSetting("preferences", { notifications: { enabled: false } });
  for (const e of events) s.insert(e);
  s.projectDirty();
  change?.(s);
  const file = path.join(root, name + ".sqlite");
  await backup(s.db, file);
  s.close();
  return file;
}
test("missing old history is restored while current-only events and current device survive", async () => {
  const current = await fixture("current", [
    event("metadata", "session_meta"),
    event("new", "usage_response", "current", "new-session"),
  ]);
  const legacy = await fixture("legacy", [
    event("old", "usage_response", "legacy"),
  ]);
  const before = [sha(current), sha(legacy)];
  const output = path.join(root, "merged");
  await recoverHistory({ current, legacy, output });
  const db = new DatabaseSync(path.join(output, "monitor.sqlite"), {
    readOnly: true,
  });
  assert.equal((db.prepare("SELECT count(*) n FROM events").get() as any).n, 3);
  assert.equal(
    (
      db
        .prepare("SELECT total_tokens FROM sessions WHERE id='historical'")
        .get() as any
    ).total_tokens,
    120,
  );
  assert.equal(
    JSON.parse(
      (
        db
          .prepare("SELECT value FROM settings WHERE key='deviceId'")
          .get() as any
      ).value,
    ),
    "current-device",
  );
  assert.equal(
    (db.prepare("SELECT count(*) n FROM events WHERE id='new'").get() as any).n,
    1,
  );
  db.close();
  assert.deepEqual([sha(current), sha(legacy)], before);
});

function read(
  file: string,
  sql: string,
  ...params: (string | number)[]
): any[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
test("same event ID retains current parser evidence and archives differing legacy evidence without double counting", async () => {
  const live = event("same", "usage_response");
  const old = {
    ...live,
    sourceId: "old-source",
    deviceId: "old-device",
    data: { usage: { input: 999, output: 999 } },
  };
  const current = await fixture("duplicate-current", [live]);
  const legacy = await fixture("duplicate-old", [old]);
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "duplicates"),
  });
  assert.equal(result.counts.eventsAdded, 0);
  assert.equal(result.counts.eventsArchived, 1);
  assert.deepEqual(
    read(result.file, "SELECT * FROM events"),
    read(current, "SELECT * FROM events"),
  );
  assert.equal(
    read(result.file, "SELECT total_tokens FROM sessions")[0].total_tokens,
    120,
  );
  const archived = JSON.parse(
    read(
      result.file,
      "SELECT json FROM history_recovery_evidence WHERE table_name='events'",
    )[0].json,
  );
  assert.equal(JSON.parse(archived.json).data.usage.input, 999);
});

test("complete overlap metadata is archived only with proved capture-normalized provenance", async () => {
  const make = (source: string) => ({
    ...event("dbmeta:" + source, "session_meta", source),
    projectId:
      "project:" +
      hash(source + "-environment:" + path.normalize("C:/work/project")),
    data: {
      title: "same",
      sourceKind: "database",
      metadataOnly: true,
      projectPath: "C:/work/project",
    },
  });
  const current = await fixture("metadata-current", [make("current")]);
  const different = make("different");
  different.projectId = "unproved-project";
  const legacy = await fixture("metadata-old", [make("legacy"), different]);
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "metadata"),
  });
  assert.equal(result.counts.metadataDuplicatesArchived, 1);
  assert.equal(result.counts.eventsAdded, 1);
  assert.equal(read(result.file, "SELECT count(*) n FROM events")[0].n, 2);
});

test("notes, pins, current settings, opaque credential rows, cursors and account bindings survive; legacy identity is archived", async () => {
  const current = await fixture(
    "protected-current",
    [event("protected-new", "usage_response")],
    (s) => {
      s.db.prepare("UPDATE sessions SET notes=?,pinned=1").run("keep my note");
      s.db
        .prepare("INSERT INTO annotations VALUES(?,?,?)")
        .run("historical", "keep my note", 1);
      s.db
        .prepare("INSERT INTO settings VALUES(?,?)")
        .run(
          "opaqueCredentialFixture",
          JSON.stringify({ encrypted: 1, ciphertext: "unchanged" }),
        );
      s.db
        .prepare("INSERT INTO cursors VALUES(?,?,?,?)")
        .run("/my-log", 913, "signature", '{"turn":1}');
      s.db
        .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
        .run("account", "confirmed account", "codex", "confirmed");
      s.db
        .prepare("INSERT INTO bindings VALUES(?,?,?,?,?,?,?)")
        .run(
          "binding",
          "account",
          "current",
          "2026-01-01",
          "2027-01-01",
          "confirmed",
          0,
        );
    },
  );
  const legacy = await fixture("protected-old", [
    event("protected-old", "usage_response", "legacy", "old-session"),
  ]);
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "protected"),
  });
  for (const table of ["settings", "cursors", "bindings", "annotations"])
    assert.deepEqual(
      read(result.file, `SELECT * FROM ${table}`),
      read(current, `SELECT * FROM ${table}`),
    );
  assert.deepEqual(
    read(
      result.file,
      "SELECT notes,pinned FROM sessions WHERE id='historical'",
    ),
    [{ notes: "keep my note", pinned: 1 }].map((r) =>
      Object.assign(Object.create(null), r),
    ),
  );
  assert.ok(
    read(
      result.file,
      "SELECT 1 FROM history_recovery_evidence WHERE table_name='settings' AND row_key='deviceId'",
    ).length,
  );
});

test("legacy quota IDs return as observations while matching quota conflicts remain archived and account identities stay distinct", async () => {
  const add = (s: Store, id: string, account: string, percent: number) => {
    s.db
      .prepare("INSERT OR IGNORE INTO accounts VALUES(?,?,?,?)")
      .run(account, "same display", "codex", "unknown");
    s.db
      .prepare("INSERT INTO quotas VALUES(?,?,?,?,?,?)")
      .run(
        id,
        account,
        "pool",
        "weekly",
        "2026-10-01T00:00:00Z",
        JSON.stringify({ accountId: account, percent }),
      );
  };
  const current = await fixture("quota-current", [], (s) =>
    add(s, "same-quota", "current-account", 50),
  );
  const legacy = await fixture("quota-old", [], (s) => {
    add(s, "same-quota", "legacy-account", 50);
    add(s, "old-quota", "legacy-account", 45);
  });
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "quotas"),
  });
  assert.equal(result.counts.quotasAdded, 1);
  assert.equal(result.counts.quotasArchived, 1);
  assert.equal(read(result.file, "SELECT count(*) n FROM accounts")[0].n, 2);
  assert.equal(
    read(result.file, "SELECT account_id FROM quotas WHERE id='same-quota'")[0]
      .account_id,
    "current-account",
  );
  assert.equal(
    read(result.file, "SELECT account_id FROM quotas WHERE id='old-quota'")[0]
      .account_id,
    "legacy-account",
  );
});

test("existing deletion markers win in either direction and never produce active history or usage", async () => {
  const current = await fixture(
    "deleted-current",
    [event("to-remove", "usage_response", "current", "deleted-in-old")],
    (s) =>
      s.db
        .prepare("INSERT INTO tombstones VALUES(?,?)")
        .run("deleted-in-current", "2026-10-02"),
  );
  const legacy = await fixture(
    "deleted-old",
    [
      event(
        "must-not-return",
        "usage_response",
        "legacy",
        "deleted-in-current",
      ),
    ],
    (s) =>
      s.db
        .prepare("INSERT INTO tombstones VALUES(?,?)")
        .run("deleted-in-old", "2026-10-01"),
  );
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "deletions"),
  });
  for (const table of ["events", "sessions", "usage_points"])
    assert.equal(read(result.file, `SELECT count(*) n FROM ${table}`)[0].n, 0);
  assert.equal(read(result.file, "SELECT count(*) n FROM tombstones")[0].n, 2);
});

test("repeated migration is idempotent including evidence archives and usage points", async () => {
  const current = await fixture("repeat-current", [
    event("repeat-new", "usage_response", "current", "new"),
  ]);
  const legacy = await fixture("repeat-old", [
    event("repeat-old", "usage_response", "old", "old"),
  ]);
  const first = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "repeat-first"),
  });
  const second = await recoverHistory({
    current: first.file,
    legacy,
    outputDir: path.join(root, "repeat-second"),
  });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  for (const table of [
    "events",
    "sessions",
    "usage_points",
    "settings",
    "history_recovery_evidence",
    "history_recovery_inputs",
  ])
    assert.deepEqual(
      read(first.file, `SELECT * FROM ${table} ORDER BY rowid`),
      read(second.file, `SELECT * FROM ${table} ORDER BY rowid`),
    );
  assert.equal(second.counts.eventsAdded, 0);
  assert.equal(second.counts.eventsArchived, 0);
});

test("schema two current snapshot upgrades only on output and rebuilds snapshot-only and inherited usage correctly", async () => {
  const snap = {
    ...event("snapshot", "usage_snapshot", "current", "parent"),
    data: { usage: { input: 100, output: 20 } },
  };
  const current = await fixture("schema-current", [snap], (s) =>
    s.db.exec("PRAGMA user_version=2"),
  );
  const inherited = {
    ...event("fork-copy", "usage_response", "legacy", "child"),
    data: { usage: { input: 100, output: 20 }, inherited: true },
  };
  const legacy = await fixture("schema-old", [
    inherited,
    event("child-new", "usage_response", "legacy", "child", 2),
  ]);
  const inputHash = sha(current);
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "schema-upgraded"),
  });
  assert.equal(read(result.file, "PRAGMA user_version")[0].user_version, 3);
  assert.equal(read(current, "PRAGMA user_version")[0].user_version, 2);
  assert.equal(sha(current), inputHash);
  assert.equal(
    read(result.file, "SELECT total_tokens FROM sessions WHERE id='parent'")[0]
      .total_tokens,
    120,
  );
  assert.equal(
    read(result.file, "SELECT total_tokens FROM sessions WHERE id='child'")[0]
      .total_tokens,
    120,
  );
});

test("preview does the complete rehearsal but leaves original files and destination unchanged", async () => {
  const current = await fixture("preview-current", [
    event("preview-new", "usage_response"),
  ]);
  const legacy = await fixture("preview-old", [
    event("preview-old", "usage_response", "old", "old"),
  ]);
  const before = [sha(current), sha(legacy)];
  const workDir = path.join(root, "preview-scratch");
  const result = await planHistoryRecovery({ current, legacy, workDir });
  assert.equal(result.counts.eventsAdded, 1);
  assert.deepEqual(fs.readdirSync(workDir), []);
  assert.deepEqual([sha(current), sha(legacy)], before);
  assert.equal(fs.existsSync(current + "-shm"), false);
  assert.equal(fs.existsSync(legacy + "-shm"), false);
});

test("recovery count survives projection consumption and reports restored full session headers", async () => {
  const current = await fixture("count-current", [
    event("count-metadata", "session_meta"),
  ]);
  const header = {
    ...event("count-full-header", "session_meta", "legacy"),
    data: { title: "full old header", sourceKind: "log" },
  };
  const legacy = await fixture("count-old", [
    header,
    event("count-usage", "usage_response", "legacy"),
  ]);
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "count-recovered"),
  });
  assert.equal(result.counts.sessionsRecovered, 1);
  assert.notEqual(
    read(result.file, "SELECT uncertain FROM sessions WHERE id='historical'")[0]
      .uncertain,
    2,
  );
  assert.equal(
    read(
      result.file,
      "SELECT total_tokens FROM sessions WHERE id='historical'",
    )[0].total_tokens,
    120,
  );
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(result.file))
      .filter((f) => !f.endsWith("-shm") && !f.endsWith("-wal"))
      .sort(),
    ["history-recovery-summary.json", "monitor.sqlite"],
  );
});

test("inconsistent inputs, changed digests and existing output are rejected before modifying inputs", async () => {
  const current = await fixture("invalid-current", []),
    legacy = await fixture("invalid-old", []);
  const before = [sha(current), sha(legacy)];
  await assert.rejects(
    planHistoryRecovery({ current, legacy, expectedLegacySha256: "changed" }),
    /input-changed/,
  );
  fs.writeFileSync(legacy + "-wal", "not-a-completed-snapshot");
  await assert.rejects(
    planHistoryRecovery({ current, legacy }),
    /completed-snapshot/,
  );
  fs.unlinkSync(legacy + "-wal");
  fs.writeFileSync(legacy + "-journal", "in-progress");
  await assert.rejects(
    planHistoryRecovery({ current, legacy }),
    /completed-snapshot/,
  );
  fs.unlinkSync(legacy + "-journal");
  await assert.rejects(
    recoverHistory({ current, legacy, outputDir: root }),
    /output-already-exists/,
  );
  assert.deepEqual([sha(current), sha(legacy)], before);
});

test("conflicting accounts and annotations fail without replacing either source", async () => {
  for (const kind of ["accounts", "annotations"] as const) {
    const set = (s: Store, value: string) =>
      kind === "accounts"
        ? s.db
            .prepare(
              "INSERT INTO accounts VALUES('same',?,'codex','confirmed')",
            )
            .run(value)
        : s.db
            .prepare("INSERT INTO annotations VALUES('session',?,0)")
            .run(value);
    const current = await fixture("conflict-current-" + kind, [], (s) =>
      set(s, "current"),
    );
    const legacy = await fixture("conflict-old-" + kind, [], (s) =>
      set(s, "legacy"),
    );
    const before = [sha(current), sha(legacy)];
    await assert.rejects(
      planHistoryRecovery({ current, legacy }),
      new RegExp("conflicting-" + kind),
    );
    assert.deepEqual([sha(current), sha(legacy)], before);
  }
});

test("active pairing, pending revocation and revoked grants all require explicit sharing-aware migration", async () => {
  const clean = await fixture("sharing-clean", []);
  for (const mode of ["pair", "pending", "revoked"]) {
    const active = await fixture("sharing-" + mode, [], (s) => {
      if (mode === "revoked")
        s.db.prepare("INSERT INTO grants VALUES('old-grant','{}',1)").run();
      else
        s.db
          .prepare("INSERT INTO settings VALUES(?,?)")
          .run(
            mode === "pair" ? "hubPairs" : "pendingRevocations",
            mode === "pair"
              ? '{"encrypted":1,"ciphertext":"opaque"}'
              : '["old-grant"]',
          );
    });
    await assert.rejects(
      planHistoryRecovery({ current: active, legacy: clean }),
      /sharing-state-requires-specialist/,
    );
    await assert.rejects(
      planHistoryRecovery({ current: clean, legacy: active }),
      /sharing-state-requires-specialist/,
    );
  }
});
