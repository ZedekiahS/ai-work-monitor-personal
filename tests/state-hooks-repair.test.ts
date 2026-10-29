import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyState, presentState, Event } from "../core/model.js";
import { parseLine } from "../collector/codex.js";
import { spawnSync } from "node:child_process";
import { Store } from "../core/store.js";
import { readHookQueue } from "../collector/hooks.js";
import {
  hookConfiguration,
  installationStatus,
} from "../collector/hook-install.js";
const at = "2026-10-26T06:00:00.000Z";
function event(kind: string, patch: Partial<Event> = {}): Event {
  return {
    id: kind,
    upstreamId: null,
    provider: "codex",
    deviceId: "d",
    environmentId: "env",
    sourceId: "source",
    sessionId: "parent",
    turnId: "turn1",
    agentId: "parent",
    accountId: null,
    projectId: "project",
    kind,
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    sequence: 1,
    schemaVersion: 2,
    evidence: "confirmed",
    data: {},
    ...patch,
  };
}
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-state-hooks-"));
  const store = new Store(dir);
  store.setSetting("preferences", { hooksEnabled: true });
  return {
    dir,
    store,
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("confirmed terminal cannot be reopened by inferred same-turn resume; a new turn can start", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const current = {
      state,
      turnId: "turn1",
      at,
      evidence: "confirmed" as const,
    };
    assert.equal(
      applyState(
        current,
        event("turn_resumed", {
          evidence: "inferred",
          occurredAt: "2026-10-26T06:00:01.000Z",
        }),
      ).state,
      state,
    );
    const next = applyState(
      current,
      event("turn_started", {
        turnId: "turn2",
        occurredAt: "2026-10-26T06:00:02.000Z",
      }),
    );
    assert.equal(next.state, "running");
    assert.equal(next.turnId, "turn2");
  }
});
test("late confirmed terminal overrides lower-trust same-turn callback, but not a newer turn", () => {
  const inferred = {
    state: "running" as const,
    turnId: "turn1",
    at: "2026-10-26T06:00:09.000Z",
    evidence: "inferred" as const,
  };
  assert.equal(
    applyState(inferred, event("turn_completed")).state,
    "completed",
  );
  assert.equal(
    applyState(
      { ...inferred, turnId: "turn2", evidence: "confirmed" },
      event("turn_completed"),
    ).state,
    "running",
  );
});
test("state freshness uses state occurrence time rather than unrelated later activity or replay receipt", () => {
  const s: any = {
    state: "running",
    updatedAt: "2026-10-26T06:10:00.000Z",
    stateOccurredAt: at,
    stateObservedAt: "2026-10-26T06:10:00.000Z",
  };
  assert.equal(presentState(s, Date.parse(s.updatedAt)).state, "unknown");
  assert.equal(presentState(s, Date.parse(s.updatedAt)).lastState, "running");
  const lateStart = event("turn_started", {
    turnId: "new",
    occurredAt: "2026-10-26T05:59:59.000Z",
    receivedAt: "2026-10-26T06:10:00.000Z",
  });
  assert.equal(
    applyState(
      { state: "completed", turnId: "turn1", at, evidence: "confirmed" },
      lateStart,
    ).state,
    "completed",
  );
});
test("session status filters agree with unknown presentation after fresh usage follows an old running event", () => {
  const f = temporary();
  try {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 600_000).toISOString();
    f.store.insert(event("turn_started", { occurredAt: old, observedAt: old }));
    f.store.insert(
      event("usage_snapshot", {
        occurredAt: now,
        observedAt: now,
        data: { usage: { input: 1, output: 1 } },
      }),
    );
    f.store.projectDirty();
    const all = f.store.sessions(new URLSearchParams()).items;
    assert.equal(all[0].state, "unknown");
    assert.equal(all[0].lastState, "running");
    assert.equal(
      f.store.sessions(new URLSearchParams({ status: "running" })).items.length,
      0,
    );
    assert.deepEqual(
      f.store
        .sessions(new URLSearchParams({ status: "unknown" }))
        .items.map((s) => s.id),
      ["parent"],
    );
  } finally {
    f.close();
  }
});
test("fresh same-turn work keeps an old running turn in the current list", () => {
  for (const kind of [
    "tool_started",
    "tool_activity",
    "tool_finished",
    "agent_message",
  ]) {
    const f = temporary();
    try {
      const old = new Date(Date.now() - 600_000).toISOString();
      const now = new Date().toISOString();
      f.store.insert(
        event("turn_started", { occurredAt: old, observedAt: old }),
      );
      f.store.insert(event(kind, { occurredAt: now, observedAt: now }));
      f.store.projectDirty();
      const running = f.store.sessions(
        new URLSearchParams({ status: "running" }),
      ).items;
      assert.deepEqual(
        running.map((s) => s.id),
        ["parent"],
        kind,
      );
      assert.equal(running[0].freshness, "fresh");
      assert.equal(
        f.store.sessions(new URLSearchParams({ status: "unknown" })).total,
        0,
      );
    } finally {
      f.close();
    }
  }
});
test("activity cannot revive a terminal, waiting or different turn, and replay keeps its original clock", () => {
  const running = {
    state: "running" as const,
    turnId: "turn1",
    at,
    evidence: "confirmed" as const,
  };
  for (const state of [
    "completed",
    "failed",
    "cancelled",
    "waiting_user",
    "waiting_approval",
  ] as const) {
    const current = { ...running, state };
    assert.deepEqual(
      applyState(
        current,
        event("tool_started", { occurredAt: "2026-10-26T06:10:00Z" }),
      ),
      current,
    );
  }
  for (const patch of [
    { turnId: "turn2" },
    { turnId: null },
    { data: { runtimeScope: "independent-app-server" } },
  ]) {
    assert.deepEqual(
      applyState(
        running,
        event("tool_started", { occurredAt: "2026-10-26T06:10:00Z", ...patch }),
      ),
      running,
    );
  }
  const replay = applyState(
    running,
    event("tool_started", {
      occurredAt: "2026-10-26T06:00:01Z",
      observedAt: "2026-10-26T06:10:00Z",
    }),
  );
  assert.equal(
    presentState(
      { ...replay, stateOccurredAt: replay.at } as any,
      Date.parse("2026-10-26T06:10:00Z"),
    ).state,
    "unknown",
  );
});
test("raw parser preserves explicit agent identity and does not copy parent turn from subagent Hook", () => {
  const ctx: any = {
    deviceId: "d",
    environmentId: "e",
    sourceId: "s",
    sessionId: "fallback",
    accountId: null,
    projectId: "p",
    turnId: null,
    model: "m",
    cutoff: null,
    forked: false,
    hasResponseUsage: false,
  };
  const meta = parseLine(
    JSON.stringify({
      type: "session_meta",
      timestamp: at,
      payload: {
        id: "child-session",
        session_id: "parent",
        agent_id: "real-agent-id",
        parent_thread_id: "parent",
      },
    }),
    ctx,
    0,
    at,
  )!;
  assert.equal(meta.agentId, "real-agent-id");
  assert.equal(meta.sessionId, "child-session");
  const started = parseLine(
    JSON.stringify({
      type: "event_msg",
      timestamp: at,
      payload: { type: "task_started", turn_id: "child-turn" },
    }),
    ctx,
    1,
    at,
  )!;
  assert.equal(started.agentId, "real-agent-id");
});
test("receiver retains only the user-input boolean and identity, never tool contents", () => {
  const f = temporary();
  try {
    fs.writeFileSync(
      path.join(f.dir, "hook-enabled.json"),
      JSON.stringify({ enabled: true }),
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/hook-receiver.mjs", f.dir],
      {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "parent",
          turn_id: "turn1",
          agent_id: "agent",
          tool_name: "functions.request_user_input_async",
          tool_input: { question: "PRIVATE_PROMPT" },
          last_assistant_message: "PRIVATE_REPLY",
        }),
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    const raw = fs.readFileSync(path.join(f.dir, "hook-queue.jsonl"), "utf8");
    const p = JSON.parse(raw);
    assert.equal(p.agentId, "agent");
    assert.equal(p.waitsForUser, true);
    assert.equal(p.schemaVersion, 2);
    assert.equal(raw.includes("PRIVATE"), false);
    assert.equal(raw.includes("request_user_input"), false);
    f.store.insert(event("session_meta", { turnId: null }));
    f.store.projectDirty();
    // The settings endpoint resets this value to null when the user enables Hooks.
    f.store.setSetting("lastHookObservedAt", null);
    assert.equal(readHookQueue(f.store), 1);
    const wait = f.store
      .allEvents("parent")
      .find((e) => e.kind === "waiting_user")!;
    assert.ok(wait);
    assert.equal(wait.data.timeBasis, "hook_callback_observed");
    assert.equal(wait.data.upstreamOccurredAt, null);
    assert.equal(f.store.getSetting("lastHookObservedAt", null), p.observedAt);
  } finally {
    f.close();
  }
});
test("Hook before session indexing persists across restart then replays exactly once", () => {
  const f = temporary();
  let open = f.store;
  try {
    fs.writeFileSync(
      path.join(f.dir, "hook-queue.jsonl"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "parent",
        turnId: "turn1",
        kind: "PermissionRequest",
        observedAt: at,
      }) + "\n",
    );
    assert.equal(readHookQueue(open), 0);
    open.close();
    open = new Store(f.dir);
    open.insert(
      event("session_meta", { turnId: null, data: { title: "parent" } }),
    );
    open.projectDirty();
    assert.equal(readHookQueue(open), 1);
    assert.equal(readHookQueue(open), 0);
    assert.equal(open.getSetting("lastHookObservedAt", ""), at);
    const replayed = open
      .allEvents("parent")
      .find((e) => e.kind === "waiting_approval")!;
    assert.equal(replayed.observedAt, at);
    assert.equal(replayed.occurredAt, at);
    assert.notEqual(replayed.receivedAt, at);
    assert.equal(
      open.allEvents("parent").filter((e) => e.kind === "waiting_approval")
        .length,
      1,
    );
  } finally {
    open.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("subagent callbacks use child identity and never complete or restart the parent", () => {
  const f = temporary();
  try {
    f.store.insert(
      event("session_meta", { turnId: null, data: { title: "parent" } }),
    );
    f.store.insert(event("turn_started"));
    f.store.insert(
      event("session_meta", {
        id: "child-meta",
        sessionId: "child",
        agentId: "child",
        turnId: null,
        data: { title: "child", parentId: "parent", relation: "spawn" },
      }),
    );
    f.store.projectDirty();
    fs.writeFileSync(
      path.join(f.dir, "hook-queue.jsonl"),
      ["SubagentStart", "SubagentStop"]
        .map((kind, i) =>
          JSON.stringify({
            schemaVersion: 1,
            sessionId: "parent",
            turnId: "parent-turn",
            agentId: "child",
            kind,
            observedAt: `2026-10-26T06:00:0${i + 1}.000Z`,
          }),
        )
        .join("\n") + "\n",
    );
    readHookQueue(f.store);
    f.store.projectDirty();
    const callbacks = f.store
      .allEvents("child")
      .filter((e) => e.data.evidenceSource === "opt-in-local-hook");
    assert.equal(callbacks.length, 2);
    assert.ok(
      callbacks.every((e) => e.agentId === "child" && e.sessionId === "child"),
    );
    assert.ok(callbacks.every((e) => e.data.parentId === "parent"));
    assert.equal(
      (
        f.store.db
          .prepare("SELECT state FROM sessions WHERE id=?")
          .get("parent") as any
      ).state,
      "running",
    );
    assert.ok(!callbacks.some((e) => e.kind === "turn_completed"));
  } finally {
    f.close();
  }
});
test("child callback waits for alias indexing and supplies only an unambiguous missing parent relation", () => {
  const f = temporary();
  try {
    f.store.insert(event("session_meta", { turnId: null }));
    f.store.projectDirty();
    fs.writeFileSync(
      path.join(f.dir, "hook-queue.jsonl"),
      JSON.stringify({
        schemaVersion: 2,
        sessionId: "parent",
        turnId: "parent-turn",
        agentId: "real-child-agent",
        kind: "SubagentStart",
        observedAt: "2026-10-26T06:00:01.000Z",
      }) + "\n",
    );
    assert.equal(readHookQueue(f.store), 0);
    assert.equal(f.store.getSetting("hookPendingCount", 0), 1);
    f.store.insert(
      event("session_meta", {
        id: "alias-child-meta",
        sessionId: "child-thread",
        agentId: "real-child-agent",
        turnId: null,
        data: { agentId: "real-child-agent" },
      }),
    );
    f.store.projectDirty();
    assert.equal(readHookQueue(f.store), 1);
    f.store.projectDirty();
    const callback = f.store
      .allEvents("child-thread")
      .find((e) => e.kind === "agent_started")!;
    assert.equal(callback.agentId, "real-child-agent");
    assert.equal(callback.turnId, null);
    assert.equal(callback.data.parentTurnId, "parent-turn");
    assert.equal(callback.data.relationEvidence, "hook_contract");
    const child: any = f.store.db
      .prepare("SELECT parent_id,relation FROM sessions WHERE id=?")
      .get("child-thread");
    assert.equal(child.parent_id, "parent");
    assert.equal(child.relation, "spawn");
    assert.equal(f.store.getSetting("hookPendingCount", -1), 0);
  } finally {
    f.close();
  }
});
test("child callback cannot override a known conflicting parent or revive a deleted session", () => {
  const f = temporary();
  try {
    f.store.insert(event("session_meta", { turnId: null }));
    f.store.insert(
      event("session_meta", {
        id: "wrong-child-meta",
        sessionId: "child",
        agentId: "child",
        turnId: null,
        data: { parentId: "another-parent", relation: "spawn" },
      }),
    );
    f.store.projectDirty();
    fs.writeFileSync(
      path.join(f.dir, "hook-queue.jsonl"),
      JSON.stringify({
        schemaVersion: 2,
        sessionId: "parent",
        agentId: "child",
        kind: "SubagentStop",
        observedAt: "2026-10-26T06:00:01.000Z",
      }) + "\n",
    );
    assert.equal(readHookQueue(f.store), 0);
    assert.equal(f.store.getSetting("hookPendingCount", 0), 1);
    assert.equal(
      f.store.allEvents("child").some((e) => e.kind === "agent_stopped"),
      false,
    );
    f.store.db.prepare("INSERT INTO tombstones VALUES(?,?)").run("child", at);
    assert.equal(readHookQueue(f.store), 0);
    assert.equal(f.store.getSetting("hookPendingCount", -1), 0);
  } finally {
    f.close();
  }
});
test("upgraded Hook preview reports missing input observation without rewriting an enabled old configuration", () => {
  const f = temporary();
  try {
    const config = hookConfiguration(f.dir);
    delete (config.hooks as any).PreToolUse;
    const configFile = path.join(f.dir, "hooks.json");
    const handlers = Object.entries(config.hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) => g.hooks.map((handler) => ({ event, handler }))),
    );
    const raw = JSON.stringify(config);
    fs.writeFileSync(configFile, raw);
    fs.writeFileSync(
      path.join(f.dir, "hook-install.json"),
      JSON.stringify({ file: configFile, handlers }),
    );
    fs.writeFileSync(
      path.join(f.dir, "hook-enabled.json"),
      JSON.stringify({ enabled: true, since: at }),
    );
    const status = installationStatus(f.dir, true, at);
    assert.equal(status.configured, true);
    assert.equal(status.status, "observed");
    assert.equal(status.updateAvailable, true);
    assert.deepEqual(status.missingEvents, ["PreToolUse"]);
    assert.equal(fs.readFileSync(configFile, "utf8"), raw);
    assert.equal(f.store.getSetting<any>("preferences", {}).hooksEnabled, true);
  } finally {
    f.close();
  }
});
