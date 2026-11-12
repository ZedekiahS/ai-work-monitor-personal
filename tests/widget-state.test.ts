import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import type { Event } from "../core/model.js";

test("expired waits stay actionable without claiming fresh state; confirmed completion clears them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-widget-state-"));
  const store = new Store(dir);
  const old = new Date(Date.now() - 120000).toISOString();
  const event = (kind: string, id: string, at = old): Event => ({
    id,
    upstreamId: null,
    provider: "codex",
    deviceId: "d",
    environmentId: "e",
    sourceId: "s",
    sessionId: "task",
    turnId: "turn",
    agentId: "task",
    accountId: null,
    projectId: "p",
    kind,
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    sequence: 1,
    schemaVersion: 2,
    evidence: "confirmed",
    data: {},
  });
  try {
    store.insert(event("turn_started", "start"));
    store.insert(event("waiting_approval", "wait"));
    store.projectDirty();
    const overview = store.overview();
    assert.equal(
      overview.activity.items.length,
      1,
      "pending approval must not disappear after freshness timeout",
    );
    assert.equal(overview.activity.items[0].state, "unknown");
    assert.equal(overview.activity.items[0].lastState, "waiting_approval");
    assert.equal(overview.activity.items[0].freshness, "stale");
    assert.equal(overview.activity.waitingCount, 1);
    store.insert(event("turn_completed", "done", new Date().toISOString()));
    store.projectDirty();
    assert.equal(store.overview().activity.waitingCount, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
