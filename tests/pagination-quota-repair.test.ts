import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import type { Event } from "../core/model.js";
const at = "2026-10-26T12:00:00.000Z";
function event(id: string, sessionId = "session"): Event {
  return {
    id,
    sessionId,
    upstreamId: null,
    provider: "codex",
    deviceId: "device",
    environmentId: "env",
    sourceId: "source",
    turnId: "turn",
    agentId: sessionId,
    accountId: null,
    projectId: "project",
    kind: "message",
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    sequence: 1,
    schemaVersion: 2,
    evidence: "confirmed",
    data: {},
  };
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awm-pages-"));
  const store = new Store(dir);
  return {
    store,
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("205 equal-timestamp events are all reachable with a stable composite cursor", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 205; i++)
      f.store.insert(event("event-" + String(i).padStart(4, "0")));
    f.store.projectDirty();
    const first: any = f.store.detail("session");
    assert.equal(first.events.length, 200);
    const second: any = f.store.detail(
      "session",
      first.nextBefore ?? first.events[0].occurredAt,
    );
    assert.equal(second.events.length, 5);
    const ids = [...first.events, ...second.events].map((e) => e.id);
    assert.equal(new Set(ids).size, 205);
    assert.equal(second.nextBefore, null);
  } finally {
    f.close();
  }
});
test("unknown quota identities stay separate in history but latest cards group only by source", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 50; i++)
      f.store.addQuota({
        id: "q" + i,
        accountId: "unknown:codex:" + i,
        sourceId: "quota-probe:" + i,
        pool: "codex",
        window: "weekly",
        remainingPercent: 60,
        resetsAt: null,
        observedAt: new Date(Date.parse(at) + i * 1000).toISOString(),
        freshness: "fresh",
      });
    assert.equal(f.store.quotas().length, 1);
    assert.equal((f.store.quotas()[0] as any).unbound, true);
    assert.equal(f.store.quotas()[0].accountId, "unknown:codex:49");
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM quotas").get() as any).n,
      50,
    );
    f.store.addQuota({
      id: "other",
      accountId: "unknown:source:other",
      sourceId: "other",
      pool: "codex",
      window: "weekly",
      remainingPercent: 60,
      resetsAt: null,
      observedAt: at,
      freshness: "fresh",
    });
    assert.equal(f.store.quotas().length, 2);
  } finally {
    f.close();
  }
});
