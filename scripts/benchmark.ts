import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../core/store.js";
import { Collector } from "../collector/collector.js";
import { setTimeout as delay } from "node:timers/promises";
const count = Math.max(
  1_000_000,
  Number(process.env.AIWM_BENCH_EVENTS) || 1_000_000,
);
const dir = path.resolve("work", "benchmark-" + Date.now());
const store = new Store(dir);
let peakRss = process.memoryUsage().rss;
const at = "2026-10-01T00:00:00.000Z";
const start = performance.now();
const insert = store.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)");
for (let base = 0; base < count; base += 5000) {
  store.transaction(() => {
    for (let i = base; i < Math.min(count, base + 5000); i++) {
      const sid = "bench-session-" + Math.floor(i / 100);
      const id = "bench-event-" + i;
      const date = new Date(Date.parse(at) + (i % 86400) * 1000).toISOString();
      const e = {
        id,
        upstreamId: "response-" + i,
        provider: "codex",
        deviceId: "fixture",
        environmentId: "fixture",
        sourceId: "fixture",
        sessionId: sid,
        turnId: "turn",
        agentId: sid,
        accountId: "fixture-account",
        projectId: "project-" + (i % 20),
        kind: "usage_response",
        occurredAt: date,
        observedAt: date,
        receivedAt: date,
        sequence: i,
        schemaVersion: 2,
        evidence: "confirmed",
        data: {
          usage: { input: 100, cached: 80, output: 20, reasoning: 5 },
          model: "fixture-model",
        },
      };
      insert.run(
        id,
        sid,
        "turn",
        "usage_response",
        date,
        "fixture",
        "fixture-account",
        e.projectId,
        JSON.stringify(e),
      );
      store.dirty.add(sid);
    }
  });
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (base % 100000 === 0) console.log("Synthetic imported", base);
  await delay(0);
}
const rawImportMs = performance.now() - start;
const projectionStart = performance.now();
store.projectDirty();
const projectionMs = performance.now() - projectionStart;
peakRss = Math.max(peakRss, process.memoryUsage().rss);
const percentile = (v: number[], p = 0.95) =>
  [...v].sort((a, b) => a - b)[
    Math.min(v.length - 1, Math.floor(v.length * p))
  ];
const queryMs: number[] = [];
for (let i = 0; i < 150; i++) {
  const t = performance.now();
  store.sessions(
    new URLSearchParams({
      q: i % 2 ? "bench-session-9" : "",
      page: String((i % 10) + 1),
      pageSize: "50",
      model: "fixture-model",
    }),
  );
  queryMs.push(performance.now() - t);
}
const diskAfterMillion = store.diskBytes();
const source = path.join(dir, "fixture-source");
fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
const logfile = path.join(source, "sessions", "incremental.jsonl");
const meta = JSON.stringify({
  type: "session_meta",
  ordinal: 0,
  timestamp: new Date().toISOString(),
  payload: { id: "incremental-fixture" },
});
fs.writeFileSync(logfile, meta + "\n");
const col = new Collector(store);
const cfg = {
  id: "benchmark-source",
  label: "fixture only",
  path: source,
  kind: "fixture",
  environmentId: "fixture",
};
store.setSetting("sourceConfigs", [cfg]);
const incrementStart = performance.now();
fs.appendFileSync(
  logfile,
  Array.from({ length: 1000 }, (_, i) =>
    JSON.stringify({
      type: "token_usage_record",
      ordinal: i + 1,
      timestamp: new Date().toISOString(),
      payload: {
        turn_id: "turn",
        response_id: "increment-" + i,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  ).join("\n") + "\n",
);
await col.ingestFile(logfile, cfg);
store.projectDirty();
const incremental1000Ms = performance.now() - incrementStart;
const idleStart = process.cpuUsage(),
  idleWall = performance.now();
await delay(2000);
const idleCpu = process.cpuUsage(idleStart);
const idleCpuPercent =
  ((idleCpu.user + idleCpu.system) / 1000 / (performance.now() - idleWall)) *
  100;
const lags: number[] = [];
col.start();
for (let i = 0; i < 20; i++) {
  const written = Date.now();
  const stamp = new Date(written).toISOString();
  fs.appendFileSync(
    logfile,
    JSON.stringify({
      type: "event_msg",
      ordinal: 2000 + i,
      timestamp: stamp,
      payload: { type: "task_started", turn_id: "latency-" + i },
    }) + "\n",
  );
  let observed = false;
  for (let n = 0; n < 100; n++) {
    await delay(50);
    const found = store.db
      .prepare("SELECT json FROM events WHERE turn_id=? AND kind=?")
      .get("latency-" + i, "turn_started") as any;
    if (found) {
      lags.push(Date.parse(JSON.parse(found.json).observedAt) - written);
      observed = true;
      break;
    }
  }
  if (!observed) lags.push(5000);
}
col.stop();
while (col.scan.phase === "scanning") await delay(10);
const result = {
  generatedAt: new Date().toISOString(),
  isolation: "Synthetic database only; not user Codex data",
  machine: {
    os: os.type(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
  },
  events: count,
  sessions: Math.ceil(count / 100),
  rawImportMs,
  projectionMs,
  initialIndexTotalMs: rawImportMs + projectionMs,
  incremental1000Ms,
  filterP95Ms: percentile(queryMs),
  filterMaxMs: Math.max(...queryMs),
  peakRssMiB: Math.round(peakRss / 1024 ** 2),
  idleCpuPercent,
  diskAfterMillionMiB: Math.round(diskAfterMillion / 1024 ** 2),
  diskGrowthForIncrementalMiB:
    Math.round(((store.diskBytes() - diskAfterMillion) / 1024 ** 2) * 100) /
    100,
  latency: {
    samples: lags.length,
    pollMs: 1500,
    p95Ms: percentile(lags),
    maxMs: Math.max(...lags),
    definition:
      "fixture append completed to collector observedAt; excludes upstream generation",
  },
  targets: {
    filterP95Under1000: percentile(queryMs) <= 1000,
    latencyP95Under3000: percentile(lags) <= 3000,
  },
};
store.close();
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync(
  "docs/evidence/benchmark.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
