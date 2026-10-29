import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { SyncClient } from "../collector/sync.js";
import { quotaIdentity } from "../collector/quota-identity.js";
import { parseEvent, withinGrant } from "@ai-work-monitor/sync-protocol";
test("local unknown source continuity survives restart but changes login epoch without account merging", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "awm-identity-"));
  let s = new Store(dir);
  const first = quotaIdentity(s, "quota-probe:local", null, "hash-one");
  const next = quotaIdentity(s, "quota-probe:local", null, "hash-one");
  assert.equal(first.accountId, next.accountId);
  assert.equal(first.confirmed, false);
  s.close();
  s = new Store(dir);
  assert.equal(
    quotaIdentity(s, "quota-probe:local", null, "hash-one").sourceId,
    first.sourceId,
  );
  const switched = quotaIdentity(s, "quota-probe:local", null, "hash-two");
  assert.notEqual(switched.accountId, first.accountId);
  assert.ok(
    s.getSetting<string[]>("inactiveQuotaSources", []).includes(first.sourceId),
  );
  assert.notEqual(
    quotaIdentity(s, "quota-probe:other", null, "hash-one").accountId,
    first.accountId,
  );
  assert.notEqual(
    quotaIdentity(s, "quota-probe:unguarded", null, null).accountId,
    quotaIdentity(s, "quota-probe:unguarded", null, null).accountId,
  );
  s.close();
});
test("credentials encrypt at rest, round trip after restart and migrate legacy settings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "awm-vault-"));
  let s = new Store(dir);
  s.db
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run("hubPair", JSON.stringify({ deviceToken: "synthetic-device-secret" }));
  assert.equal(
    s.getSetting<any>("hubPair", null).deviceToken,
    "synthetic-device-secret",
  );
  s.setSetting("productIdentities", {
    fixture: { token: "synthetic-owner-secret" },
  });
  const rows = JSON.stringify(s.db.prepare("SELECT value FROM settings").all());
  assert.ok(!rows.includes("synthetic-device-secret"));
  assert.ok(!rows.includes("synthetic-owner-secret"));
  assert.equal(readFileSync(path.join(dir, "credential-key.local")).length, 32);
  s.close();
  s = new Store(dir);
  assert.equal(
    s.getSetting<any>("productIdentities", {}).fixture.token,
    "synthetic-owner-secret",
  );
  s.close();
});
test("unconfirmed quota never uploads until bounded manual source mapping; switch invalidates old flow", () => {
  const s = new Store(mkdtempSync(path.join(os.tmpdir(), "awm-quota-grant-")));
  s.setSetting("deviceId", "device");
  s.setSetting("environmentId", "env");
  const sync = new SyncClient(s),
    now = Date.now();
  const g = {
    id: "g",
    workspaceId: "w",
    userId: "u",
    accountIds: ["manual:a"],
    projectIds: [],
    from: new Date(now - 1000).toISOString(),
    to: new Date(now + 86400000).toISOString(),
    shareQuota: true,
    retentionDays: 30,
  };
  s.db.prepare("INSERT INTO grants VALUES(?,?,0)").run(g.id, JSON.stringify(g));
  s.db
    .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
    .run("manual:a", "我的账号", "codex", "manual");
  const q = {
    id: "q",
    accountId: "unknown:source",
    sourceId: "quota-probe:s",
    pool: "codex",
    window: "300",
    remainingPercent: 70,
    resetsAt: null,
    observedAt: new Date(now).toISOString(),
    freshness: "fresh",
    identityEvidence: "unconfirmed" as const,
  };
  s.addQuota(q);
  sync.enqueue();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
    0,
  );
  s.createBinding({
    accountId: "manual:a",
    sourceId: q.sourceId,
    from: g.from,
    to: g.to,
  });
  sync.enqueue();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
    1,
  );
  const payload = JSON.parse(
    (s.db.prepare("SELECT json FROM outbox").get() as any).json,
  );
  assert.equal(payload.evidence, "inferred");
  s.setSetting("inactiveQuotaSources", [q.sourceId]);
  sync.enqueue();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM outbox WHERE acked=0").get() as any)
      .n,
    0,
  );
  assert.ok(s.db.prepare("SELECT 1 FROM sync_blocked").get());
  sync.stop();
  s.close();
});
test("public payload rejects credential fields, and a grant uses an exclusive end", () => {
  const now = Date.now(),
    stamp = new Date(now).toISOString(),
    e = {
      seq: 1,
      eventId: "e",
      grantId: "g",
      provider: "codex",
      sourceId: "s",
      environmentId: "env",
      sessionId: "session",
      turnId: null,
      agentId: null,
      parentId: null,
      relation: null,
      accountId: "a",
      projectId: "p",
      kind: "usage",
      occurredAt: stamp,
      observedAt: stamp,
      model: "model",
      state: null,
      evidence: "confirmed",
      usage: { input: 2, cached: 1, output: 3, reasoning: 1 },
    };
  assert.throws(() => parseEvent({ ...e, accessToken: "synthetic-secret" }));
  assert.throws(() =>
    parseEvent({
      ...e,
      usage: { input: 2, cached: 3, output: 3, reasoning: 1 },
    }),
  );
  assert.equal(
    withinGrant(
      parseEvent(e),
      {
        id: "g",
        workspaceId: "w",
        userId: "u",
        accountIds: ["a"],
        projectIds: ["p"],
        from: new Date(now - 1000).toISOString(),
        to: stamp,
        shareQuota: false,
        retentionDays: 30,
      },
      now - 1,
    ),
    "outside_time_scope",
  );
});
