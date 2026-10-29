import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { SyncClient } from "../collector/sync.js";
import type { Event } from "../core/model.js";

test("heartbeat activity is receiver, account, project, time and consent scoped", async (t) => {
  for (const mode of [
    "none",
    "quota",
    "private",
    "account",
    "creator-only",
    "other-receiver",
    "future",
    "expired",
    "paused",
    "revoked",
    "work",
  ] as const) {
    await t.test(mode, async () => {
      const store = new Store(
        mkdtempSync(path.join(os.tmpdir(), "awm-heartbeat-")),
      );
      const sync = new SyncClient(store);
      const now = Date.now(),
        at = new Date(now).toISOString();
      const connection = sync.addConnection({
        url: "https://sync.example",
        deviceToken: "synthetic",
        deviceId: "d",
        workspaceId: "w",
        userId: "u",
        protocolVersion: 1,
      });
      const e: Event = {
        id: "start",
        upstreamId: null,
        provider: "codex",
        deviceId: "d",
        environmentId: "env",
        sourceId: "source",
        sessionId: "task",
        turnId: "turn",
        agentId: "task",
        accountId: "a",
        projectId: mode === "private" ? "private" : "work",
        kind: "turn_started",
        occurredAt: at,
        observedAt: at,
        receivedAt: at,
        sequence: 1,
        schemaVersion: 2,
        evidence: "confirmed",
        data: {
          accountEvidence:
            mode === "creator-only" ? "session_creator_only" : "turn_context",
          model: "未知",
        },
      };
      store.insert(e);
      store.projectDirty();
      if (mode !== "none")
        store.db.prepare("INSERT INTO grants VALUES(?,?,?)").run(
          "g",
          JSON.stringify({
            id: "g",
            workspaceId: "w",
            userId: "u",
            connectionId: mode === "other-receiver" ? "other" : connection.id,
            accountIds: [mode === "account" ? "other-account" : "a"],
            projectIds: mode === "quota" ? [] : ["work"],
            shareQuota: true,
            from: new Date(
              now + (mode === "future" ? 60000 : -60000),
            ).toISOString(),
            to: new Date(
              now + (mode === "expired" ? -1000 : 3600000),
            ).toISOString(),
            retentionDays: 30,
            paused: mode === "paused",
          }),
          mode === "revoked" ? 1 : 0,
        );
      const calls: any[] = [];
      sync.request = async (route, _method, body) => {
        calls.push({ route, body });
        return route.startsWith("/v1/grants?")
          ? { grants: [] }
          : route === "/v1/ingest"
            ? {
                ackSeq: Math.max(...body.events.map((x: any) => x.seq)),
                accepted: body.events.length,
                duplicates: 0,
                rejected: [],
              }
            : { ok: true };
      };
      try {
        await sync.once();
        const heartbeat = calls.find((c) => c.route === "/v1/heartbeat").body;
        if (mode === "work") {
          assert.equal(heartbeat.taskState, "running");
          assert.equal(heartbeat.taskActivity.grantId, "g");
          const queued = store.db
            .prepare("SELECT json FROM outbox WHERE grant_id='g'")
            .all() as { json: string }[];
          assert.ok(
            queued.length > 0,
            "an unavailable model must not block authorized state/usage",
          );
          assert.ok(queued.every((row) => JSON.parse(row.json).model === null));
          sync.pause("g", true);
          await sync.once();
          assert.ok(
            !calls.filter((c) => c.route === "/v1/heartbeat").at(-1).body
              .taskActivity,
          );
        } else {
          assert.ok(
            heartbeat.taskState === undefined ||
              heartbeat.taskState === null ||
              heartbeat.taskState === "unknown",
            mode + " leaked activity",
          );
          assert.ok(!heartbeat.taskActivity);
        }
      } finally {
        sync.stop();
        store.close();
      }
    });
  }
});

test("heartbeat sequence survives Monitor restart and credential update does not switch the selected receiver", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "awm-heartbeat-sequence-"));
  let store = new Store(dir),
    sync = new SyncClient(store);
  const a = sync.addConnection({
    url: "https://sync.example",
    deviceToken: "a",
    deviceId: "a",
    workspaceId: "w",
    userId: "u",
    protocolVersion: 1,
  });
  const values: number[] = [];
  const capture = (client: SyncClient) =>
    (client.request = async (route, _method, body) => {
      if (route === "/v1/heartbeat") values.push(body.heartbeatSeq);
      return route.startsWith("/v1/grants?") ? { grants: [] } : { ok: true };
    });
  capture(sync);
  await sync.once();
  sync.stop();
  store.close();
  store = new Store(dir);
  sync = new SyncClient(store);
  capture(sync);
  await sync.once();
  assert.deepEqual(values, [1, 2]);
  const b = sync.addConnection({
    url: "https://sync.example",
    deviceToken: "b",
    deviceId: "b",
    workspaceId: "w2",
    userId: "u",
    protocolVersion: 1,
  });
  sync.updateCredential(a.id, "new-a");
  assert.equal(sync.pairInfo()!.id, b.id);
  assert.equal(store.getSetting<any>("hubPair", null).id, b.id);
  sync.stop();
  store.close();
});
