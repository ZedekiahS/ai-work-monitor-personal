import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Store } from "../core/store.js";
import { Event } from "../core/model.js";

function fixture() {
  const dir = path.resolve(
    "work",
    "history-usage-availability-" + randomUUID(),
  );
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}
function event(
  kind: Event["kind"],
  sessionId: string,
  data: Record<string, any>,
): Event {
  return {
    id: kind + ":" + sessionId,
    sessionId,
    turnId: "turn",
    agentId: sessionId,
    upstreamId: kind === "usage_response" ? "response" : null,
    deviceId: "device",
    environmentId: "environment",
    sourceId: "source",
    projectId: "project",
    accountId: null,
    provider: "codex",
    kind,
    evidence: "confirmed",
    schemaVersion: 2,
    sequence: 1,
    occurredAt: "2026-10-01T00:00:00Z",
    observedAt: "2026-10-01T00:00:00Z",
    receivedAt: "2026-10-01T00:00:00Z",
    data,
  };
}
test("full log header without usage evidence reports unavailable instead of measured zero", () => {
  const s = fixture();
  try {
    s.insert(
      event("session_meta", "header-only", {
        title: "historical header",
        sourceKind: "log",
      }),
    );
    s.projectDirty();
    const list = s.sessions(new URLSearchParams()).items[0];
    assert.equal(list.metadataOnly, false);
    assert.equal(list.usageAvailable, false);
    assert.equal(list.totalTokens, null);
    const detail = s.detail("header-only")!;
    assert.equal(detail.session.metadataOnly, false);
    assert.equal(detail.session.usageAvailable, false);
    assert.equal(detail.session.totalTokens, null);
    assert.equal(detail.usage, null);
    assert.equal(detail.agents[0].usageAvailable, false);
  } finally {
    s.close();
  }
});
test("actual zero response or cumulative snapshot is an available measured zero", () => {
  const s = fixture();
  try {
    for (const kind of ["usage_response", "usage_snapshot"] as const) {
      s.insert(event("session_meta", kind, { title: kind, sourceKind: "log" }));
      s.insert(
        event(kind, kind, {
          usage: { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 },
        }),
      );
    }
    s.projectDirty();
    for (const row of s.sessions(new URLSearchParams()).items) {
      assert.equal(row.usageAvailable, true);
      assert.equal(row.totalTokens, 0);
      const detail = s.detail(row.id)!;
      assert.equal(detail.session.usageAvailable, true);
      assert.equal(detail.usage!.total, 0);
    }
  } finally {
    s.close();
  }
});
test("database-only metadata remains unavailable and separately labelled metadata-only", () => {
  const s = fixture();
  try {
    s.insert(
      event("session_meta", "db-only", {
        title: "db",
        sourceKind: "database",
        metadataOnly: true,
      }),
    );
    s.projectDirty();
    const detail = s.detail("db-only")!;
    assert.equal(detail.session.metadataOnly, true);
    assert.equal(detail.session.usageAvailable, false);
    assert.equal(detail.session.totalTokens, null);
    assert.equal(detail.usage, null);
  } finally {
    s.close();
  }
});
