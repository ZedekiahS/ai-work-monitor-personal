import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Event, usageFromEvents, usagePoints } from "../core/model.js";
import { Store } from "../core/store.js";
import { DatabaseSync } from "node:sqlite";

function event(
  id: string,
  sequence: number,
  kind: string,
  input: number,
  output: number,
  turnId: string | null = "turn1",
  data: Record<string, any> = {},
): Event {
  const at = new Date(Date.UTC(2026, 9, 26, 0, 0, sequence)).toISOString();
  return {
    id,
    sequence,
    kind,
    sessionId: "session",
    turnId,
    agentId: "session",
    upstreamId: kind === "usage_response" ? id : null,
    provider: "codex",
    deviceId: "fixture-device",
    environmentId: "fixture",
    sourceId: "fixture-source",
    projectId: "fixture-project",
    accountId: "fixture-account",
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    evidence: "confirmed",
    schemaVersion: 2,
    data: { usage: { input, output }, ...data },
  };
}
function total(events: Event[]) {
  return usagePoints(events).reduce((n, p) => n + p.usage.total, 0);
}

test("v4 stored wait state is repaired once with a consistent backup and unchanged raw events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-wait-upgrade-"));
  const store = new Store(dir);
  try {
    store.insert(event("start", 1, "turn_started", 0, 0));
    store.insert(event("approve", 2, "waiting_approval", 0, 0, "turn1", { toolCallId: "tool-A" }));
    store.insert(event("input", 3, "waiting_user", 0, 0, "turn1", { toolCallId: "question-B" }));
    store.projectDirty();
    store.db.exec("UPDATE sessions SET state='waiting_user',notes='keep',pinned=1");
    store.setSetting("derivedProjectionVersion", 4);
    const raw = store.db.prepare("SELECT * FROM events ORDER BY id").all();
    const repaired = await store.recomputeDerived();
    assert.equal(repaired.skipped, false);
    assert.ok(repaired.backup);
    const copy = new DatabaseSync(path.join(dir, "backups", repaired.backup!), { readOnly: true });
    try { assert.equal(copy.prepare("SELECT state FROM sessions").get()!.state, "waiting_user"); }
    finally { copy.close(); }
    assert.equal(store.db.prepare("SELECT state FROM sessions").get()!.state, "waiting_approval");
    assert.deepEqual(store.db.prepare("SELECT * FROM events ORDER BY id").all(), raw);
    assert.deepEqual({ ...store.db.prepare("SELECT notes,pinned FROM sessions").get() }, { notes: "keep", pinned: 1 });
    assert.equal((await store.recomputeDerived()).skipped, true);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("regression: snapshot then overlapping response cannot produce 120 in one path and 240 in persistent points", () => {
  const events = [
    event("snapshot", 1, "usage_snapshot", 100, 20),
    event("response", 2, "usage_response", 100, 20),
  ];
  assert.equal(usageFromEvents(events).usage.total, 120);
  assert.equal(total(events), 120);
});
test("snapshot-only prior history remains when a later distinct turn has response records of identical size", () => {
  const events = [
    event("snapshot", 1, "usage_snapshot", 100, 20, "old-turn"),
    event("response", 2, "usage_response", 100, 20, "new-turn"),
  ];
  assert.equal(usageFromEvents(events).usage.total, 240);
  assert.equal(total(events), 240);
});
test("partial overlap and later cumulative checkpoint agree across summaries and trend points", () => {
  const events = [
    event("snapshot1", 1, "usage_snapshot", 100, 20),
    event("response1", 2, "usage_response", 40, 10),
    event("response2", 3, "usage_response", 50, 10, "turn2"),
    event("snapshot2", 4, "usage_snapshot", 150, 30, "turn2"),
  ];
  assert.equal(usageFromEvents(events).usage.total, 180);
  assert.equal(total(events), 180);
});
test("history delivery order and duplicate response business IDs do not change the canonical projection", () => {
  const s = event("snapshot", 2, "usage_snapshot", 100, 20);
  const r = event("response", 1, "usage_response", 100, 20);
  const duplicate = {
    ...r,
    id: "copied-row",
    sourceId: "fixture-copy",
    receivedAt: "2026-10-27T00:00:00.000Z",
  };
  const first = usagePoints([s, r, duplicate]);
  const replay = usagePoints([duplicate, r, s, s]);
  assert.deepEqual(first, replay);
  assert.equal(total([s, r, duplicate]), 120);
});
test("cumulative rollback remains uncertain without inventing reset-period usage; explicit epoch reset is additive", () => {
  const rollback = [
    event("s1", 1, "usage_snapshot", 100, 10),
    event("s2", 2, "usage_snapshot", 10, 1),
    event("s3", 3, "usage_snapshot", 20, 2),
  ];
  assert.equal(usageFromEvents(rollback).usage.total, 121);
  assert.equal(total(rollback), 121);
  assert.equal(usageFromEvents(rollback).uncertain, true);
  const reset = rollback.map((e) => ({
    ...e,
    data: { ...e.data, usageEpoch: e.sequence === 1 ? "before" : "after" },
  }));
  assert.equal(total(reset), 132);
});
test("fork inherited history is excluded; child own usage and identical separate response IDs are retained", () => {
  const inherited = event(
    "ancestor",
    1,
    "usage_snapshot",
    1000,
    100,
    "parent-turn",
    { inherited: true, usageUncertain: true },
  );
  const events = [
    inherited,
    event("a", 2, "usage_response", 10, 2),
    event("b", 3, "usage_response", 10, 2),
  ];
  assert.equal(total(events), 24);
  assert.equal(usageFromEvents(events).uncertain, true);
});

test("fork cumulative counters use an evidenced inherited baseline, or expose an unknown first baseline", () => {
  const meta = event("child-meta", 0, "session_meta", 0, 0, null, {
    forked: true,
    cutoff: 5,
    parentId: "parent",
    relation: "fork",
  });
  const inherited = event(
    "inherited-counter",
    1,
    "usage_snapshot",
    1000,
    100,
    "parent-turn",
    { inherited: true },
  );
  const first = event(
    "child-counter1",
    5,
    "usage_snapshot",
    1020,
    110,
    "child-turn",
  );
  const second = event(
    "child-counter2",
    6,
    "usage_snapshot",
    1030,
    112,
    "child-turn",
  );
  assert.equal(total([meta, inherited, first, second]), 42);
  const boundaryOnly = usageFromEvents([meta, first, second]);
  assert.equal(boundaryOnly.usage.total, 12);
  assert.equal(boundaryOnly.uncertain, true);
  const direct = event(
    "child-response",
    4,
    "usage_response",
    20,
    10,
    "child-turn",
  );
  assert.equal(total([meta, direct, first, second]), 30);
});
test("persistent projection follows the unified rule and a full replay is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-usage-repair-"));
  const store = new Store(dir);
  try {
    store.insert(event("snapshot", 1, "usage_snapshot", 100, 20));
    store.projectDirty();
    store.insert(event("response", 2, "usage_response", 100, 20));
    store.projectDirty();
    assert.equal(store.overview().usage.total, 120);
    assert.equal(store.detail("session")!.usage!.total, 120);
    assert.equal(
      store.usage().days.reduce((n, day) => n + day.total, 0),
      120,
    );
    const before = JSON.stringify(
      store.db.prepare("SELECT id,usage FROM usage_points ORDER BY id").all(),
    );
    store.dirty.add("session");
    store.projectDirty();
    assert.equal(
      JSON.stringify(
        store.db.prepare("SELECT id,usage FROM usage_points ORDER BY id").all(),
      ),
      before,
    );
    assert.equal(
      (store.db.prepare("SELECT count(*) n FROM events").get() as any).n,
      2,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derived migration repairs old persisted double-counts, includes WAL in backup and preserves private/sync state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-migrate-"));
  const store = new Store(dir);
  try {
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    const s = event("snapshot", 1, "usage_snapshot", 100, 20),
      r = event("response", 2, "usage_response", 100, 20);
    store.insert(s);
    store.insert(r);
    store.projectDirty();
    const wrong = {
      input: 200,
      cached: 0,
      output: 40,
      reasoning: 0,
      total: 240,
    };
    store.db
      .prepare(
        "UPDATE sessions SET usage=?,total_tokens=240,notes='keep note',pinned=1 WHERE id='session'",
      )
      .run(JSON.stringify(wrong));
    store.db.prepare("INSERT INTO usage_points VALUES(?,?,?,?,?,?,?,?)").run(
      "snapshot:delta",
      s.sessionId,
      s.occurredAt,
      "model",
      s.projectId,
      s.accountId,
      JSON.stringify({
        input: 100,
        cached: 0,
        output: 20,
        reasoning: 0,
        total: 120,
      }),
      JSON.stringify(s),
    );
    store.setSetting("deviceId", "stable-device");
    store.setSetting("environmentId", "stable-environment");
    store.setSetting("preferences", { hooksEnabled: true, pollMs: 3000 });
    store.setSetting("hubPairs", [
      { id: "original-pair", deviceToken: "fixture-secret" },
    ]);
    store.setSetting("pendingRevocations", ["revoked-grant"]);
    store.setSetting("pendingErases", ["deleted-session"]);
    store.db
      .prepare("INSERT INTO grants VALUES(?,?,1)")
      .run("revoked-grant", JSON.stringify({ id: "revoked-grant" }));
    store.db
      .prepare(
        "INSERT INTO outbox(event_id,grant_id,json,acked) VALUES(?,?,?,0)",
      )
      .run("frozen-attempt", "revoked-grant", "{}");
    store.db
      .prepare("INSERT INTO cursors VALUES(?,?,?,?)")
      .run("fixture-log", 777, "source-fingerprint", "{}");
    store.db
      .prepare("INSERT INTO tombstones VALUES(?,?)")
      .run("deleted-session", s.occurredAt);
    store.createBinding({
      accountId: "fixture-account",
      sourceId: "fixture-source",
      from: "2026-01-01T00:00:00Z",
      to: "2027-01-01T00:00:00Z",
    });
    store.db.exec(
      "CREATE TABLE sync_point_state(event_id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO sync_point_state VALUES('frozen-point',7)",
    );
    const tables = [
      "events",
      "bindings",
      "accounts",
      "outbox",
      "grants",
      "cursors",
      "tombstones",
      "sync_point_state",
    ];
    const frozen = tables.map((table) =>
      JSON.stringify(
        store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    );
    const settings = [
      "deviceId",
      "environmentId",
      "preferences",
      "hubPairs",
      "pendingRevocations",
      "pendingErases",
    ];
    const originalSettings = settings.map((k) =>
      JSON.stringify(store.getSetting(k, null)),
    );
    const result = await store.recomputeDerived({ force: true });
    assert.ok(result.backup);
    const copy = new DatabaseSync(path.join(dir, "backups", result.backup!), {
      readOnly: true,
    });
    try {
      assert.equal(
        (copy.prepare("SELECT count(*) n FROM events").get() as any).n,
        2,
      );
      assert.equal(
        (
          copy
            .prepare("SELECT total_tokens FROM sessions WHERE id='session'")
            .get() as any
        ).total_tokens,
        240,
      );
      assert.equal(
        Object.values(copy.prepare("PRAGMA integrity_check").get()!)[0],
        "ok",
      );
    } finally {
      copy.close();
    }
    assert.equal(store.overview().usage.total, 120);
    const detail = store.detail("session")!;
    assert.equal(detail.session.notes, "keep note");
    assert.equal(detail.session.pinned, true);
    assert.equal(detail.usageUncertain, true);
    const canonical = JSON.stringify(
      store.db.prepare("SELECT * FROM usage_points ORDER BY id").all(),
    );
    await store.recomputeDerived({ backup: false, force: true });
    assert.equal(
      JSON.stringify(
        store.db.prepare("SELECT * FROM usage_points ORDER BY id").all(),
      ),
      canonical,
    );
    assert.deepEqual(
      tables.map((table) =>
        JSON.stringify(
          store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ),
      ),
      frozen,
    );
    assert.deepEqual(
      settings.map((k) => JSON.stringify(store.getSetting(k, null))),
      originalSettings,
    );
    assert.equal(store.getSetting("indexRebuilding", true), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint across turns reconciles prior responses and exposes allocation uncertainty instead of double-counting", () => {
  const rows = [
    event("r1", 1, "usage_response", 60, 10, "turn1"),
    event("s2", 3, "usage_snapshot", 100, 20, "turn2"),
    event("r2", 4, "usage_response", 40, 10, "turn2"),
  ];
  assert.equal(total(rows), 120);
  assert.equal(usageFromEvents(rows).uncertain, true);
  assert.ok(
    usagePoints(rows).every((p) => p.event.data.usageAllocationUncertain),
  );
  assert.equal(
    JSON.stringify(rows).includes("usageAllocationUncertain"),
    false,
    "raw event input is immutable",
  );
});

test("a failed derived repair retains its upload pause and a successful retry restores the original pause state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-repair-retry-"));
  const store = new Store(dir);
  try {
    store.insert(event("one", 1, "usage_snapshot", 100, 20));
    const project = store.projectDirty.bind(store);
    store.projectDirty = () => {
      throw new Error("fixture projection failure");
    };
    await assert.rejects(
      store.recomputeDerived({ backup: false }),
      /fixture projection failure/,
    );
    assert.equal(store.getSetting("indexRebuilding", false), true);
    assert.equal(store.getSetting("derivedProjectionVersion", 0), 0);
    store.projectDirty = project;
    await store.recomputeDerived({ backup: false });
    assert.equal(store.getSetting("indexRebuilding", false), false);
    assert.equal(store.detail("session")?.usage?.total, 120);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema 1 upgrades additive state columns and credential format to schema 3 and retains existing data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-schema-upgrade-"));
  let store = new Store(dir);
  try {
    store.insert(event("one", 1, "usage_snapshot", 100, 20));
    store.projectDirty();
    store.db.exec(
      "ALTER TABLE sessions DROP COLUMN state_at; ALTER TABLE sessions DROP COLUMN state_observed_at; PRAGMA user_version=1",
    );
    store.close();
    store = new Store(dir);
    assert.equal(
      (store.db.prepare("PRAGMA user_version").get() as any).user_version,
      3,
    );
    assert.equal(store.detail("session")?.usage?.total, 120);
    assert.ok(
      store.db
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .some((r) => r.name === "state_at"),
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("independent sessions sharing an upstream response ID retain distinct persistent points and v2 upgrade is idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-scoped-response-"));
  const store = new Store(dir);
  try {
    const one = {
      ...event("one", 1, "usage_response", 100, 20),
      sessionId: "session-one",
      upstreamId: "response-common",
    };
    const two = {
      ...event("two", 2, "usage_response", 50, 10),
      sessionId: "session-two",
      upstreamId: "response-common",
    };
    store.insert(one);
    store.insert(two);
    store.projectDirty();
    assert.equal(store.overview().usage.total, 180);
    assert.equal(
      store.usage().days.reduce((sum, day) => sum + day.total, 0),
      180,
    );
    assert.equal(new Set(usagePoints([one, two]).map((p) => p.id)).size, 2);
    assert.equal(
      usagePoints([one])[0].id,
      usagePoints([
        { ...one, deviceId: "other-device", sourceId: "other-source" },
      ])[0].id,
    );
    store.db.prepare("DELETE FROM usage_points").run();
    store.db
      .prepare("INSERT INTO usage_points VALUES(?,?,?,?,?,?,?,?)")
      .run(
        "codex:response:response-common",
        one.sessionId,
        one.occurredAt,
        "model",
        one.projectId,
        one.accountId,
        JSON.stringify(usageFromEvents([one]).usage),
        JSON.stringify(one),
      );
    store.setSetting("derivedProjectionVersion", 2);
    const repaired = await store.recomputeDerived({ backup: false });
    assert.equal(repaired.skipped, false);
    assert.equal(repaired.version, 5);
    assert.equal(
      store.usage().days.reduce((sum, day) => sum + day.total, 0),
      180,
    );
    assert.equal(
      (store.db.prepare("SELECT count(*) n FROM usage_points").get() as any).n,
      2,
    );
    assert.equal(
      (await store.recomputeDerived({ backup: false })).skipped,
      true,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
