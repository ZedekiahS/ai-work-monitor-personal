import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { Collector } from "../collector/collector.js";
import { parseLine } from "../collector/codex.js";
import {
  applyState,
  presentState,
  usagePoints,
  usageFromEvents,
  Event,
  ParserContext,
} from "../core/model.js";
const at = "2026-10-26T06:00:00.000Z";
const context = (): ParserContext => ({
  deviceId: "device1",
  environmentId: "env1",
  sourceId: "source1",
  sessionId: "thread1",
  accountId: null,
  projectId: "unknown",
  turnId: null,
  model: "gpt-test",
  cutoff: null,
  forked: false,
  hasResponseUsage: false,
});
function event(kind: string, opts: any = {}): Event {
  return {
    id: "e-" + Math.random(),
    upstreamId: null,
    provider: "codex",
    deviceId: "d",
    environmentId: "env",
    sourceId: "s",
    sessionId: "thread1",
    turnId: "turn1",
    agentId: "thread1",
    accountId: null,
    projectId: "project1",
    kind,
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    sequence: 1,
    schemaVersion: 1,
    evidence: "confirmed",
    data: {},
    ...opts,
  };
}
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-test-"));
  const store = new Store(dir);
  return {
    store,
    dir,
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("旧终态晚到不覆盖新轮次；工具错误和独立AppServer状态不结束任务", () => {
  let s: any = { state: "running", turnId: "turn2", at, evidence: "confirmed" };
  s = applyState(
    s,
    event("turn_completed", {
      turnId: "turn1",
      occurredAt: "2026-10-26T06:01:00Z",
    }),
  );
  assert.equal(s.state, "running");
  s = applyState(s, event("tool_failed"));
  assert.equal(s.state, "running");
  s = applyState(
    s,
    event("turn_completed", {
      turnId: "turn2",
      data: { runtimeScope: "independent-app-server" },
    }),
  );
  assert.equal(s.state, "running");
});
test("静默或来源不可用保留最后观察，不伪造idle或结束", () => {
  const s: any = { updatedAt: at, state: "running" };
  assert.equal(presentState(s, Date.parse(at) + 60000).state, "unknown");
  assert.equal(presentState(s, Date.parse(at) + 60000).lastState, "running");
  assert.equal(
    presentState(s, Date.parse(at), 15000, false).freshness,
    "unavailable",
  );
  assert.equal(
    presentState({ ...s, state: "completed" }, Date.parse(at) + 60000).state,
    "completed",
  );
});
test("逐响应与累计快照不重复，缓存和推理是子集，fork排除", () => {
  const direct = event("usage_response", {
    id: "direct",
    upstreamId: "resp1",
    data: { usage: { input: 100, cached: 80, output: 20, reasoning: 10 } },
  });
  const snapshot = event("usage_snapshot", {
    data: { usage: { input: 100, cached: 80, output: 20, reasoning: 10 } },
    sequence: 2,
  });
  const points = usagePoints([
    direct,
    direct,
    snapshot,
    {
      ...direct,
      id: "fork",
      upstreamId: "resp2",
      data: { ...direct.data, inherited: true },
    },
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].usage.total, 120);
});
test("累计计数下降显式标不确定，无虚假巨大增量", () => {
  const r = usageFromEvents([
    event("usage_snapshot", { data: { usage: { input: 100, output: 10 } } }),
    event("usage_snapshot", {
      sequence: 2,
      data: { usage: { input: 10, output: 1 } },
    }),
    event("usage_snapshot", {
      sequence: 3,
      data: { usage: { input: 20, output: 2 } },
    }),
  ]);
  assert.equal(r.usage.total, 121);
  assert.equal(r.uncertain, true);
  assert.equal(r.corrections, 1);
});
test("真实新schema读取头账号/多层parent，跨设备原日志业务ID相同", () => {
  const c = context();
  const raw = JSON.stringify({
    type: "session_meta",
    ordinal: 0,
    timestamp: at,
    payload: {
      id: "thread1",
      creator_account_id: "opaque-account-a",
      parent_thread_id: "parent1",
      cwd: "C:\\a\\same",
      originator: "Codex Desktop",
      cli_version: "0.164.0-alpha",
    },
  });
  const a = parseLine(raw, c, 0)!;
  const b = parseLine(
    raw,
    {
      ...context(),
      deviceId: "device2",
      environmentId: "wsl",
      sourceId: "copy",
    },
    0,
  )!;
  assert.equal(a.id, b.id);
  assert.equal(a.data.parentId, "parent1");
  assert.ok(a.accountId?.startsWith("codex:"));
  assert.ok(!JSON.stringify(a).includes("opaque-account-a"));
});
test("持久去重、晚到父节点、永久删除后重新导入不复活", () => {
  const t = temporary();
  try {
    const child = event("session_meta", {
      sessionId: "child",
      data: { parentId: "thread1", relation: "spawn" },
    });
    for (let i = 0; i < 3; i++) t.store.insert(child);
    t.store.projectDirty();
    t.store.insert(event("session_meta"));
    t.store.projectDirty();
    assert.equal(t.store.detail("thread1")!.agents.length, 2);
    assert.equal(t.store.overview().events, 2);
    t.store.deleteSession("child");
    assert.equal(t.store.insert(child), false);
    assert.equal(t.store.detail("child"), null);
  } finally {
    t.close();
  }
});
test("同账号同额度不相加，过期不重置，未知不同源不串账号", () => {
  const t = temporary();
  try {
    const q: any = {
      id: "q1",
      accountId: "a",
      pool: "codex",
      window: "weekly",
      remainingPercent: 60,
      resetsAt: at,
      observedAt: at,
      freshness: "fresh",
      sourceId: "s1",
    };
    t.store.addQuota(q);
    t.store.addQuota({
      ...q,
      id: "q2",
      sourceId: "s2",
      observedAt: "2026-10-26T06:01:00Z",
    });
    t.store.addQuota({ ...q, id: "q3", accountId: "b" });
    assert.equal(t.store.quotas().length, 2);
    assert.equal(t.store.quotas()[0].remainingPercent, 60);
    assert.equal(t.store.quotas()[0].freshness, "stale");
  } finally {
    t.close();
  }
});
test("账号时间绑定可撤销，明确头归属不随当前账号变化", () => {
  const t = temporary();
  try {
    t.store.db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .run("a", "a", "codex", "manual");
    t.store.insert(event("session_meta"));
    t.store.projectDirty();
    const id = t.store.createBinding({
      accountId: "a",
      sourceId: "s",
      from: "2026-10-25T00:00:00Z",
      to: "2026-10-27T00:00:00Z",
    });
    assert.equal(t.store.detail("thread1")!.session.accountId, "a");
    assert.throws(() =>
      t.store.createBinding({
        accountId: "a",
        sourceId: "s",
        from: "2026-10-26T00:00:00Z",
        to: "2026-10-28T00:00:00Z",
      }),
    );
    t.store.db.prepare("UPDATE bindings SET revoked=1 WHERE id=?").run(id);
    assert.equal(t.store.detail("thread1")!.session.accountId, null);
  } finally {
    t.close();
  }
});
test("半行写入等待换行，坏行隔离，重复扫描和截断重放幂等", async () => {
  const t = temporary();
  try {
    const root = path.join(t.dir, "source");
    fs.mkdirSync(root);
    const file = path.join(root, "test.jsonl");
    const meta = JSON.stringify({
      type: "session_meta",
      timestamp: at,
      ordinal: 0,
      payload: { id: "test-session" },
    });
    fs.writeFileSync(file, meta);
    const col = new Collector(t.store);
    const c = {
      id: "source1",
      path: root,
      label: "test",
      kind: "fixture",
      environmentId: "env",
    };
    assert.equal(await col.ingestFile(file, c), 0);
    fs.appendFileSync(file, "\n{broken}\n");
    assert.equal(await col.ingestFile(file, c), 1);
    assert.equal(await col.ingestFile(file, c), 0);
    fs.writeFileSync(file, meta + "\n");
    assert.equal(await col.ingestFile(file, c), 0);
    assert.equal(col.scan.errors, 1);
  } finally {
    t.close();
  }
});
test("不同项目同名目录ID不合并", () => {
  const parse = (cwd: string) =>
    parseLine(
      JSON.stringify({ type: "session_meta", payload: { id: "t", cwd } }),
      context(),
      0,
    )!.projectId;
  assert.notEqual(parse("C:\\work\\a"), parse("D:\\private\\a"));
});
test("真实桌面子日志继承父session_meta不能改写拥有者，边界以前事件不污染父/子状态", () => {
  const c = context();
  const line = (ordinal: number, type: string, payload: any) =>
    JSON.stringify({ ordinal, type, timestamp: at, payload });
  const own = parseLine(
    line(0, "session_meta", {
      id: "child",
      session_id: "parent",
      parent_thread_id: "parent",
      subagent_history_start_ordinal: 21,
    }),
    c,
    0,
  )!;
  assert.equal(own.sessionId, "child");
  assert.equal(
    parseLine(line(1, "session_meta", { id: "parent" }), c, 100),
    null,
  );
  assert.equal(
    parseLine(
      line(2, "event_msg", { type: "task_complete", turn_id: "parentturn" }),
      c,
      200,
    ),
    null,
  );
  const live = parseLine(
    line(21, "event_msg", { type: "task_started", turn_id: "childturn" }),
    c,
    300,
  )!;
  assert.equal(live.sessionId, "child");
  assert.equal(live.turnId, "childturn");
});
test("spawn日志可同时具有forked_from_id，明确父子来源优先；普通分叉保持fork", () => {
  const spawn = parseLine(
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "child",
        forked_from_id: "parent",
        parent_thread_id: "parent",
        source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
      },
    }),
    context(),
    0,
  )!;
  assert.equal(spawn.data.relation, "spawn");
  const fork = parseLine(
    JSON.stringify({
      type: "session_meta",
      payload: { id: "fork", forked_from_id: "parent" },
    }),
    context(),
    0,
  )!;
  assert.equal(fork.data.relation, "fork");
});
