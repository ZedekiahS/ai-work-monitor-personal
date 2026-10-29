import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "../core/store.js";
import { Event, Source } from "../core/model.js";
import { SyncClient } from "../collector/sync.js";
import { recoverHistory } from "../core/history-recovery.js";

const root = path.join(os.tmpdir(), "hra-" + randomUUID().slice(0, 8));
fs.mkdirSync(root);
const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour)).toISOString();
type Binding = {
  id: string;
  account: string;
  from: number;
  to: number;
  revoked?: number;
};
function ev(
  id: string,
  session: string,
  hour: number,
  kind = "usage_response",
): Event {
  return {
    id,
    sessionId: session,
    turnId: "turn",
    kind,
    sourceId: "shared",
    environmentId: "environment",
    deviceId: "device",
    agentId: session,
    provider: "codex",
    projectId: "project",
    accountId: null,
    upstreamId: kind === "usage_response" ? id : null,
    occurredAt: at(hour),
    receivedAt: at(hour),
    observedAt: at(hour),
    sequence: hour,
    evidence: "confirmed",
    schemaVersion: 2,
    data:
      kind === "session_meta"
        ? { title: session, sourceKind: "log" }
        : { usage: { input: 100, output: 20 } },
  };
}
const source: Source = {
  id: "shared",
  label: "Codex",
  kind: "windows-desktop-or-cli",
  environmentId: "environment",
  pathLabel: ".codex",
  health: "healthy",
  lastScanAt: at(20),
  errorCount: 0,
  capabilities: { history: "logs" },
};
const digest = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function fixture(
  name: string,
  events: Event[],
  bindings: Binding[],
  change?: (s: Store) => void,
) {
  const s = new Store(path.join(root, name));
  for (const account of ["a", "b"])
    s.db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .run(account, account, "codex", "manual");
  for (const b of bindings)
    s.db
      .prepare("INSERT INTO bindings VALUES(?,?,?,?,?,?,?)")
      .run(
        b.id,
        b.account,
        "shared",
        at(b.from),
        at(b.to),
        "manual",
        b.revoked ?? 0,
      );
  for (const e of events) s.insert(e);
  s.projectDirty();
  change?.(s);
  const file = path.join(root, name + ".sqlite");
  await backup(s.db, file);
  s.close();
  return file;
}
function view(file: string) {
  const s = Object.create(Store.prototype) as Store;
  s.db = new DatabaseSync(file, { readOnly: true });
  return s;
}
function attribution(s: Store) {
  const client = Object.create(SyncClient.prototype) as SyncClient;
  client.store = s;
  const sessions = s
    .sessions(new URLSearchParams({ pageSize: "200" }))
    .items.map((r) => [r.id, r.accountId]);
  const totals: Record<string, number> = {};
  for (const p of s.db
    .prepare("SELECT * FROM usage_points ORDER BY id")
    .all() as any[]) {
    const w = client.wire(
      JSON.parse(p.event_json),
      { id: "fixture-grant" } as any,
      p.id,
    );
    const account = w?.accountId ?? "unknown";
    totals[account] = (totals[account] ?? 0) + JSON.parse(p.usage).total;
  }
  return { sessions, totals };
}
async function rejectUnchanged(
  name: string,
  current: string,
  legacy: string,
  pattern: RegExp,
) {
  const before = [digest(current), digest(legacy)];
  await assert.rejects(
    recoverHistory({
      current,
      legacy,
      outputDir: path.join(root, name + "-result"),
    }),
    pattern,
  );
  assert.deepEqual([digest(current), digest(legacy)], before);
}
test("different-ID active bindings cannot change current effective account through an overlapping interval", async () => {
  const current = await fixture(
    "overlap-current",
    [ev("current", "current-session", 2)],
    [{ id: "current-map", account: "a", from: 0, to: 4 }],
  );
  const legacy = await fixture(
    "overlap-old",
    [],
    [{ id: "old-map", account: "b", from: 1, to: 3 }],
  );
  const s = view(current);
  try {
    assert.deepEqual(attribution(s), {
      sessions: [["current-session", "a"]],
      totals: { a: 120 },
    });
  } finally {
    s.db.close();
  }
  await rejectUnchanged("overlap", current, legacy, /binding-overlap-conflict/);
});
test("adjacent half-open account intervals preserve current account statistics and attribute only restored history", async () => {
  const current = await fixture(
    "adjacent-current",
    [ev("current-adjacent", "current-session", 0)],
    [{ id: "current-map", account: "a", from: 0, to: 1 }],
  );
  const legacy = await fixture(
    "adjacent-old",
    [ev("old-adjacent", "old-session", 1)],
    [{ id: "old-map", account: "b", from: 1, to: 3 }],
  );
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "adjacent-result"),
  });
  const s = view(result.file);
  try {
    assert.equal(s.detail("current-session")!.session.accountId, "a");
    assert.equal(s.detail("old-session")!.session.accountId, "b");
    assert.deepEqual(attribution(s).totals, { a: 120, b: 120 });
    assert.equal(s.sessions(new URLSearchParams({ account: "a" })).total, 1);
    assert.equal(s.sessions(new URLSearchParams({ account: "b" })).total, 1);
  } finally {
    s.db.close();
  }
  assert.equal(result.preserved.currentAccountAttribution, true);
  assert.equal(result.preserved.currentAccountUsage, true);
});
test("same-account overlap is safe when current session and usage attribution really stay unchanged", async () => {
  const current = await fixture(
    "same-current",
    [ev("same-current", "same-session", 2)],
    [{ id: "current-map", account: "a", from: 0, to: 4 }],
  );
  const legacy = await fixture(
    "same-old",
    [],
    [{ id: "other-map", account: "a", from: 1, to: 3 }],
  );
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "same-result"),
  });
  const s = view(result.file),
    before = view(current);
  try {
    assert.deepEqual(attribution(s), attribution(before));
    assert.equal(
      (s.db.prepare("SELECT count(*) n FROM bindings").get() as any).n,
      2,
    );
  } finally {
    s.db.close();
    before.db.close();
  }
  assert.equal(result.preserved.currentAccountAttribution, true);
  assert.equal(result.preserved.currentAccountUsage, true);
});
test("legacy revoked bindings remain inert while legacy active bindings cannot revive current revoked intervals", async () => {
  const current = await fixture(
    "revoked-current",
    [ev("revoked-current", "session", 2)],
    [{ id: "current-map", account: "a", from: 0, to: 4 }],
  );
  const legacy = await fixture(
    "revoked-old",
    [],
    [{ id: "revoked-old-map", account: "b", from: 1, to: 3, revoked: 1 }],
  );
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "revoked-result"),
  });
  const s = view(result.file);
  try {
    assert.deepEqual(attribution(s).totals, { a: 120 });
  } finally {
    s.db.close();
  }
  const revokedCurrent = await fixture(
    "revoked-current2",
    [ev("revoked-current2", "session", 2)],
    [{ id: "revoked-current-map", account: "a", from: 0, to: 4, revoked: 1 }],
  );
  const activeLegacy = await fixture(
    "active-old",
    [],
    [{ id: "different-active-id", account: "a", from: 1, to: 3 }],
  );
  await rejectUnchanged(
    "revoked-block",
    revokedCurrent,
    activeLegacy,
    /binding-revocation-conflict/,
  );
});
test("same binding ID with changed contents is rejected including a revoked-to-active change", async () => {
  const current = await fixture(
    "sameid-current",
    [],
    [{ id: "same-id", account: "a", from: 0, to: 4, revoked: 1 }],
  );
  const legacy = await fixture(
    "sameid-old",
    [],
    [{ id: "same-id", account: "a", from: 0, to: 4 }],
  );
  await rejectUnchanged("sameid", current, legacy, /conflicting-bindings/);
});
test("a new mapping without an overlapping row must not silently claim current unbound sessions", async () => {
  const current = await fixture(
    "unbound-current",
    [ev("unbound", "unbound", 2)],
    [],
  );
  const legacy = await fixture(
    "unbound-old",
    [],
    [{ id: "old-map", account: "b", from: 1, to: 3 }],
  );
  await rejectUnchanged(
    "unbound",
    current,
    legacy,
    /account-attribution-changed/,
  );
});
test("usage event attribution is protected even when a later binding does not affect session-start account", async () => {
  const current = await fixture(
    "event-current",
    [
      ev("header", "session", 0, "session_meta"),
      ev("later-usage", "session", 2),
    ],
    [],
  );
  const legacy = await fixture(
    "event-old",
    [],
    [{ id: "later-map", account: "b", from: 1, to: 3 }],
  );
  await rejectUnchanged("event", current, legacy, /account-usage-changed/);
});
test("new bindings cannot remap existing quota observations even with no sessions", async () => {
  const current = await fixture("quota-current", [], [], (s) =>
    s.db.prepare("INSERT INTO quotas VALUES(?,?,?,?,?,?)").run(
      "q",
      null,
      "pool",
      "weekly",
      at(2),
      JSON.stringify({
        id: "q",
        sourceId: "shared",
        accountId: null,
        pool: "pool",
        window: "weekly",
        observedAt: at(2),
        remainingPercent: 50,
      }),
    ),
  );
  const legacy = await fixture(
    "quota-old",
    [],
    [{ id: "quota-map", account: "b", from: 1, to: 3 }],
  );
  await rejectUnchanged("quota", current, legacy, /quota-attribution-changed/);
});
test("same source identity with different observations retains current source and archives the old observation", async () => {
  const current = await fixture("source-current", [], [], (s) =>
    s.source(source),
  );
  const old = { ...source, health: "error", lastScanAt: at(1), errorCount: 4 };
  const legacy = await fixture("source-old", [], [], (s) => s.source(old));
  const result = await recoverHistory({
    current,
    legacy,
    outputDir: path.join(root, "source-result"),
  });
  const s = view(result.file);
  try {
    assert.deepEqual(s.sources(), [source]);
    const row = s.db
      .prepare(
        "SELECT json FROM history_recovery_evidence WHERE table_name='sources'",
      )
      .get() as any;
    assert.deepEqual(JSON.parse(JSON.parse(row.json).json), old);
  } finally {
    s.db.close();
  }
  const repeat = await recoverHistory({
    current: result.file,
    legacy,
    outputDir: path.join(root, "source-repeat"),
  });
  assert.equal(repeat.idempotent, true);
});
test("same-ID source identity or configured path conflicts are rejected without discarding either input", async () => {
  for (const key of ["environmentId", "kind", "pathLabel"]) {
    const current = await fixture("identity-current-" + key, [], [], (s) =>
      s.source(source),
    );
    const legacy = await fixture("identity-old-" + key, [], [], (s) =>
      s.source({ ...source, [key]: "different" }),
    );
    await rejectUnchanged(
      "identity-" + key,
      current,
      legacy,
      /source-identity-conflict/,
    );
  }
  const setup = (s: Store, p: string) => {
    s.source(source);
    s.setSetting("sourceConfigs", [
      {
        id: "shared",
        path: p,
        kind: source.kind,
        environmentId: source.environmentId,
        label: "Codex",
      },
    ]);
  };
  const current = await fixture("path-current", [], [], (s) =>
    setup(s, "C:/one/.codex"),
  );
  const legacy = await fixture("path-old", [], [], (s) =>
    setup(s, "C:/two/.codex"),
  );
  await rejectUnchanged("path", current, legacy, /source-identity-conflict/);
});

test("source configured without a first observation still rejects a conflicting historical configuration", async () => {
  const current = await fixture("source-unobserved-current", [], [], (s) =>
    s.setSetting("sourceConfigs", [
      {
        id: "shared",
        path: "C:/current/.codex",
        kind: source.kind,
        environmentId: source.environmentId,
      },
    ]),
  );
  const legacy = await fixture("source-unobserved-old", [], [], (s) => {
    s.source(source);
    s.setSetting("sourceConfigs", [
      {
        id: "shared",
        path: "C:/other/.codex",
        kind: source.kind,
        environmentId: source.environmentId,
      },
    ]);
  });
  await rejectUnchanged(
    "source-unobserved",
    current,
    legacy,
    /source-identity-conflict/,
  );
});

test("usage preservation follows measured-account precedence and does not treat creator identity as billing identity", async () => {
  for (const creatorOnly of [false, true]) {
    const usage = {
      ...ev("known-account-usage", "session", 2),
      accountId: "a",
      data: {
        usage: { input: 100, output: 20 },
        ...(creatorOnly ? { accountEvidence: "session_creator_only" } : {}),
      },
    };
    const current = await fixture(
      "wire-current-" + creatorOnly,
      [ev("known-header", "session", 0, "session_meta"), usage],
      [],
    );
    const legacy = await fixture(
      "wire-old-" + creatorOnly,
      [],
      [{ id: "later-map", account: "b", from: 1, to: 3 }],
    );
    if (creatorOnly)
      await rejectUnchanged(
        "wire-creator",
        current,
        legacy,
        /account-usage-changed/,
      );
    else {
      const result = await recoverHistory({
        current,
        legacy,
        outputDir: path.join(root, "wire-measured"),
      });
      const s = view(result.file),
        before = view(current);
      try {
        assert.deepEqual(attribution(s), attribution(before));
        assert.deepEqual(attribution(s).totals, { a: 120 });
      } finally {
        s.db.close();
        before.db.close();
      }
    }
  }
});

test("invalid binding intervals fail without producing an applicable recovery", async () => {
  const current = await fixture("invalid-interval-current", [], []);
  for (const invalid of [
    { from: 2, to: 2 },
    { from: 3, to: 1 },
    { from: 0, to: 3, revoked: 2 },
  ]) {
    const name = "invalid-interval-" + randomUUID().slice(0, 6);
    const legacy = await fixture(
      name,
      [],
      [{ id: "invalid", account: "a", ...invalid }],
    );
    await rejectUnchanged(name, current, legacy, /binding-invalid/);
  }
});
