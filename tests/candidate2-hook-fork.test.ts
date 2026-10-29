import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { readHookQueue } from "../collector/hooks.js";
import { parseLine } from "../collector/codex.js";
import { Collector } from "../collector/collector.js";
import { SyncClient } from "../collector/sync.js";
import { spawnSync } from "node:child_process";
import { hash } from "../core/model.js";
import {
  usageFromEvents,
  usagePoints,
  type ParserContext,
} from "../core/model.js";
const context = (): ParserContext => ({
  deviceId: "device",
  environmentId: "env",
  sourceId: "source",
  sessionId: "child",
  accountId: null,
  projectId: "unknown",
  turnId: null,
  model: "unknown",
  cutoff: null,
  forked: false,
  hasResponseUsage: false,
});
function fixture() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "aiwm-candidate2-hook-fork-"),
  );
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
function seed(store: Store) {
  const ctx = context(),
    at = new Date(Date.now() - 1000).toISOString();
  store.insert(
    parseLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: at,
        payload: { id: "child" },
      }),
      ctx,
      0,
    )!,
  );
  store.insert(
    parseLine(
      JSON.stringify({
        type: "event_msg",
        timestamp: at,
        payload: { type: "task_started", turn_id: "turn" },
      }),
      ctx,
      1,
    )!,
  );
  store.projectDirty();
}
function hook(
  dir: string,
  store: Store,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  fs.appendFileSync(
    path.join(dir, "hook-queue.jsonl"),
    JSON.stringify({
      schemaVersion: 2,
      sessionId: "child",
      turnId: "turn",
      agentId: "child",
      observedAt: new Date().toISOString(),
      kind,
      ...extra,
    }) + "\n",
  );
  readHookQueue(store);
  store.projectDirty();
}
test("E receiver retains documented Pre/Post invocation id without arguments or response; approval id is not assumed", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.dir, "hook-enabled.json"),
      JSON.stringify({ enabled: true }),
    );
    for (const kind of ["PreToolUse", "PostToolUse", "PermissionRequest"]) {
      const result = spawnSync(
        process.execPath,
        ["scripts/hook-receiver.mjs", f.dir],
        {
          windowsHide: true,
          encoding: "utf8",
          input: JSON.stringify({
            hook_event_name: kind,
            session_id: "child",
            turn_id: "turn",
            tool_use_id: "call-1",
            tool_name: "request_user_input",
            tool_input: { private: "SECRET" },
            tool_response: "SECRET",
          }),
        },
      );
      assert.equal(result.status, 0);
    }
    const text = fs.readFileSync(path.join(f.dir, "hook-queue.jsonl"), "utf8");
    const rows = text
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.deepEqual(
      rows.map((r) => r.toolUseId),
      ["call-1", "call-1", null],
    );
    assert.equal(text.includes("SECRET"), false);
    assert.equal(text.includes("tool_input"), false);
  } finally {
    f.close();
  }
});
for (const [kind, state] of [
  ["PreToolUse", "waiting_user"],
  ["PermissionRequest", "waiting_approval"],
] as const) {
  test(`E actual queue/store/overview: unrelated PostToolUse preserves ${state}`, () => {
    const f = fixture();
    try {
      seed(f.store);
      hook(f.dir, f.store, kind, {
        waitsForUser: true,
        toolUseId: "waiting-call",
      });
      assert.equal(f.store.overview().activity.waitingCount, 1);
      hook(f.dir, f.store, "PostToolUse", { toolUseId: "another-call" });
      assert.equal(
        f.store.sessions(new URLSearchParams()).items[0].state,
        state,
      );
      assert.equal(f.store.overview().activity.waitingCount, 1);
    } finally {
      f.close();
    }
  });
}
test("E actual queue: only matching same-turn same-agent completion resolves input wait", () => {
  const f = fixture();
  try {
    seed(f.store);
    hook(f.dir, f.store, "PreToolUse", {
      waitsForUser: true,
      toolUseId: "input-call",
    });
    for (const extra of [
      {},
      { toolUseId: "input-call", turnId: "other" },
      { toolUseId: "input-call", agentId: "other" },
    ]) {
      hook(f.dir, f.store, "PostToolUse", extra);
      assert.equal(f.store.overview().activity.waitingCount, 1);
    }
    hook(f.dir, f.store, "PostToolUse", { toolUseId: "input-call" });
    assert.equal(f.store.overview().activity.waitingCount, 0);
    assert.equal(
      f.store.sessions(new URLSearchParams()).items[0].state,
      "running",
    );
  } finally {
    f.close();
  }
});
test("E parallel waits and replay: one completion cannot clear another wait or approval", () => {
  const f = fixture();
  try {
    seed(f.store);
    const time = Date.now() - 500;
    hook(f.dir, f.store, "PreToolUse", {
      observedAt: new Date(time).toISOString(),
      waitsForUser: true,
      toolUseId: "first",
    });
    hook(f.dir, f.store, "PreToolUse", {
      observedAt: new Date(time + 1).toISOString(),
      waitsForUser: true,
      toolUseId: "second",
    });
    hook(f.dir, f.store, "PostToolUse", {
      observedAt: new Date(time + 3).toISOString(),
      toolUseId: "first",
    });
    assert.equal(f.store.overview().activity.waitingCount, 1);
    // Arrival order differs from occurrence order: projection must still retain approval.
    hook(f.dir, f.store, "PermissionRequest", {
      observedAt: new Date(time + 2).toISOString(),
    });
    hook(f.dir, f.store, "PostToolUse", {
      observedAt: new Date(time + 4).toISOString(),
      toolUseId: "second",
    });
    assert.equal(
      f.store.sessions(new URLSearchParams()).items[0].state,
      "waiting_approval",
    );
    assert.equal(f.store.overview().activity.waitingCount, 1);
    assert.equal(readHookQueue(f.store), 0);
  } finally {
    f.close();
  }
});
for (const order of [
  ["PermissionRequest", "PreToolUse"],
  ["PreToolUse", "PermissionRequest"],
] as const) {
  test(`E wait priority stays consistent on add and resolution: ${order.join(" then ")}`, () => {
    const f = fixture();
    try {
      seed(f.store);
      const time = Date.now() - 500;
      for (const [index, kind] of order.entries()) {
        hook(f.dir, f.store, kind, {
          observedAt: new Date(time + index).toISOString(),
          waitsForUser: true,
          toolUseId: "pending-input",
        });
      }
      const current = () => f.store.sessions(new URLSearchParams()).items[0];
      assert.equal(
        current().state,
        "waiting_approval",
        "unresolved approval takes priority regardless of which wait arrived last",
      );
      assert.equal(f.store.overview().states.waiting_approval, 1);
      assert.equal(f.store.overview().activity.waitingCount, 1);
      hook(f.dir, f.store, "PostToolUse", {
        observedAt: new Date(time + 2).toISOString(),
        toolUseId: "unrelated-parallel-call",
      });
      assert.equal(current().state, "waiting_approval");
      hook(f.dir, f.store, "PostToolUse", {
        observedAt: new Date(time + 3).toISOString(),
        toolUseId: "pending-input",
      });
      assert.equal(
        current().state,
        "waiting_approval",
        "answering input does not resolve an uncorrelated permission request",
      );
      assert.equal(f.store.overview().activity.waitingCount, 1);
      f.store.db
        .prepare("INSERT OR IGNORE INTO pending_projection VALUES(?)")
        .run("child");
      f.store.projectDirty();
      assert.equal(
        current().state,
        "waiting_approval",
        "history replay uses the same priority",
      );
      assert.equal(readHookQueue(f.store), 0);
    } finally {
      f.close();
    }
  });
}
export function forkRows(spawn = false) {
  const row = (ordinal: number, type: string, payload: any) =>
    JSON.stringify({
      ordinal,
      type,
      timestamp: new Date(Date.UTC(2026, 9, 28, 0, 0, ordinal)).toISOString(),
      payload,
    });
  const counter = (ordinal: number, input: number, output: number) =>
    row(ordinal, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output },
      },
    });
  return [
    row(0, "session_meta", {
      id: "child",
      forked_from_id: "parent",
      ...(spawn ? { parent_thread_id: "parent" } : {}),
      subagent_history_start_ordinal: 5,
    }),
    counter(1, 1000, 100),
    row(2, "session_meta", { id: "parent" }),
    row(3, "event_msg", { type: "task_complete", turn_id: "parent-turn" }),
    row(4, "event_msg", {
      type: "user_message",
      message: "PRIVATE_INHERITED_BODY",
    }),
    row(5, "turn_context", { turn_id: "child-turn", model: "gpt-test" }),
    counter(5, 1020, 110),
    counter(6, 1030, 112),
  ];
}
for (const spawn of [false, true])
  test(`F raw JSONL ${spawn ? "spawn plus fork" : "fork"}: own points and summary equal 42`, () => {
    const ctx = context(),
      events = forkRows(spawn)
        .map((s, i) => parseLine(s, ctx, i))
        .filter((e) => e !== null);
    assert.equal(usageFromEvents(events).usage.total, 42);
    assert.equal(
      usagePoints(events).reduce((n, p) => n + p.usage.total, 0),
      42,
    );
    assert.equal(events.filter((e) => e.kind === "session_meta").length, 1);
    assert.equal(
      events.some(
        (e) => e.kind === "turn_completed" || e.kind === "user_message",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(events).includes("PRIVATE_INHERITED_BODY"),
      false,
    );
  });
test("F missing raw baseline remains uncertain with only 12 attributable tokens", () => {
  const ctx = context(),
    events = forkRows()
      .filter((_, i) => i !== 1)
      .map((s, i) => parseLine(s, ctx, i))
      .filter((e) => e !== null);
  assert.equal(usageFromEvents(events).usage.total, 12);
  assert.equal(usageFromEvents(events).uncertain, true);
});
for (const missing of [false, true])
  test(`F indexed history source ${missing ? "unavailable" : "replay"}: preserve existing events and private state`, async () => {
    const f = fixture();
    try {
      const sourceDir = path.join(f.dir, "source");
      fs.mkdirSync(sourceDir);
      const file = path.join(sourceDir, "rollout.jsonl");
      fs.writeFileSync(file, forkRows(true).join("\n") + "\n");
      const originalSource = hash(fs.readFileSync(file, "utf8"));
      const config = {
        id: "source",
        environmentId: "env",
        path: sourceDir,
        label: "fixture",
        kind: "native",
      };
      f.store.setSetting("sourceConfigs", [config]);
      const collector = new Collector(f.store);
      await collector.ingestFile(file, config);
      // Reconstruct the previously indexed rows and cursor left by candidate.1.
      f.store.db.exec(
        "DELETE FROM events WHERE json_extract(json,'$.data.baselineOnly')=1",
      );
      const old = f.store.db
        .prepare("SELECT context FROM cursors WHERE path=?")
        .get(file) as any;
      const oldContext = JSON.parse(old.context);
      delete oldContext.baselineParsingVersion;
      f.store.db
        .prepare("UPDATE cursors SET context=? WHERE path=?")
        .run(JSON.stringify(oldContext), file);
      f.store.projectDirty();
      f.store.db.exec("UPDATE sessions SET notes='retained',pinned=1");
      f.store.setSetting("pendingRevocations", ["withdrawn"]);
      f.store.db
        .prepare("INSERT INTO grants VALUES(?,?,1)")
        .run("withdrawn", JSON.stringify({ id: "withdrawn" }));
      const originals = f.store.db
        .prepare("SELECT id,json FROM events ORDER BY id")
        .all();
      const device = f.store.getSetting("deviceId", "");
      assert.equal(f.store.overview().usage.total, 12);
      if (missing)
        f.store.db
          .prepare("UPDATE cursors SET path=? WHERE path=?")
          .run(file + ".unavailable", file);
      const result = await collector.repairForkBaselines();
      assert.equal(result.unavailable, missing ? 1 : 0);
      assert.equal(result.baselineEventsAdded, missing ? 0 : 1);
      assert.equal(f.store.overview().usage.total, missing ? 12 : 42);
      assert.equal(f.store.detail("child")!.session.usageUncertain, missing);
      assert.equal(f.store.detail("child")!.session.notes, "retained");
      assert.equal(f.store.detail("child")!.session.pinned, true);
      assert.equal(f.store.getSetting("deviceId", ""), device);
      assert.deepEqual(f.store.getSetting("pendingRevocations", []), [
        "withdrawn",
      ]);
      const own = f.store.db
        .prepare(
          "SELECT id,json FROM events WHERE coalesce(json_extract(json,'$.data.baselineOnly'),0)=0 ORDER BY id",
        )
        .all();
      assert.deepEqual(own, originals);
      assert.equal(
        (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
        0,
      );
      const repeat = await collector.repairForkBaselines();
      assert.equal(repeat.baselineEventsAdded, 0);
      assert.equal(hash(fs.readFileSync(file, "utf8")), originalSource);
      assert.equal(
        Object.values(f.store.db.prepare("PRAGMA integrity_check").get()!)[0],
        "ok",
      );
    } finally {
      f.close();
    }
  });

test("F recovered baseline queues only the missing owned usage, with repeat and withdrawn grants protected", async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, "rollout.jsonl");
    fs.writeFileSync(file, forkRows().join("\n") + "\n");
    const config = {
      id: "source",
      environmentId: "env",
      path: f.dir,
      label: "fixture",
      kind: "native",
    };
    f.store.setSetting("sourceConfigs", [config]);
    const collector = new Collector(f.store);
    await collector.ingestFile(file, config);
    f.store.db.exec(
      "DELETE FROM events WHERE json_extract(json,'$.data.baselineOnly')=1",
    );
    const old = f.store.db
      .prepare("SELECT context FROM cursors WHERE path=?")
      .get(file) as any;
    const context = JSON.parse(old.context);
    delete context.baselineParsingVersion;
    f.store.db
      .prepare("UPDATE cursors SET context=? WHERE path=?")
      .run(JSON.stringify(context), file);
    f.store.projectDirty();
    f.store.db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .run("manual:owner", "fixture", "codex", "manual");
    f.store.createBinding({
      accountId: "manual:owner",
      sourceId: "source",
      from: "2026-01-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
    const grant = {
      id: "active",
      workspaceId: "workspace",
      userId: "owner",
      accountIds: ["manual:owner"],
      projectIds: ["unknown"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
      retentionDays: 365,
      shareQuota: false,
    };
    f.store.db
      .prepare("INSERT INTO grants VALUES(?,?,0)")
      .run(grant.id, JSON.stringify(grant));
    f.store.db
      .prepare("INSERT INTO grants VALUES(?,?,1)")
      .run("withdrawn", JSON.stringify({ ...grant, id: "withdrawn" }));
    const sync = new SyncClient(f.store);
    sync.enqueue();
    const payloads = () =>
      (
        f.store.db
          .prepare("SELECT json FROM outbox ORDER BY seq")
          .all() as any[]
      ).map((r) => JSON.parse(r.json));
    const before = payloads().filter((p) => p.kind === "usage");
    assert.equal(
      before.reduce((n, p) => n + p.usage.input + p.usage.output, 0),
      12,
      JSON.stringify({
        blocked: f.store.db.prepare("SELECT * FROM sync_blocked").all(),
        points: f.store.db.prepare("SELECT event_json FROM usage_points").all(),
      }),
    );
    await collector.repairForkBaselines();
    sync.enqueue();
    const after = payloads();
    assert.equal(
      after
        .filter((p) => p.kind === "usage")
        .reduce((n, p) => n + p.usage.input + p.usage.output, 0),
      42,
    );
    assert.equal(
      after.some((p) => p.grantId === "withdrawn"),
      false,
    );
    assert.equal(
      after.some((p) => p.usage?.input >= 1000),
      false,
    );
    await collector.repairForkBaselines();
    sync.enqueue();
    assert.deepEqual(payloads(), after);
    sync.stop();
  } finally {
    f.close();
  }
});

test("F explicit history repair only restores indexed baseline, without ingesting appended live usage or quota", async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, "growing.jsonl"),
      config = {
        id: "source",
        environmentId: "env",
        path: f.dir,
        label: "fixture",
        kind: "native",
      };
    fs.writeFileSync(file, forkRows().join("\n") + "\n");
    f.store.setSetting("sourceConfigs", [config]);
    const collector = new Collector(f.store);
    await collector.ingestFile(file, config);
    f.store.db.exec(
      "DELETE FROM events WHERE json_extract(json,'$.data.baselineOnly')=1",
    );
    const cursor = f.store.db
      .prepare("SELECT * FROM cursors WHERE path=?")
      .get(file) as any;
    const context = JSON.parse(cursor.context);
    delete context.baselineParsingVersion;
    f.store.db
      .prepare("UPDATE cursors SET context=? WHERE path=?")
      .run(JSON.stringify(context), file);
    f.store.projectDirty();
    const appended = {
      ordinal: 7,
      type: "event_msg",
      timestamp: "2026-10-28T00:00:07.000Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 2000, output_tokens: 200 } },
        rate_limits: { primary: { used_percent: 10, window_minutes: 300 } },
      },
    };
    fs.appendFileSync(file, JSON.stringify(appended) + "\n");
    const result = await collector.repairForkBaselines();
    assert.equal(result.baselineEventsAdded, 1);
    assert.equal(f.store.overview().usage.total, 42);
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM quotas").get() as any).n,
      0,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT offset FROM cursors WHERE path=?")
          .get(file) as any
      ).offset,
      cursor.offset,
    );
    await collector.ingestFile(file, config);
    f.store.projectDirty();
    assert.equal(f.store.overview().usage.total, 1100);
  } finally {
    f.close();
  }
});
