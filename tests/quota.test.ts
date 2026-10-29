// Portions of quota window fixtures adapted from codex-usage-desktop
// codex_limits.rs:1899-1963; Copyright (c) 2026 vincent; MIT.
// See third_party/codex-usage-desktop-LICENSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.js";
import { hash } from "../core/model.js";
import { appVersion } from "../core/version.js";
import {
  createQuotaRefresher,
  quotaCommandArgs,
  quotaSnapshots,
  type SpawnQuotaProcess,
} from "../collector/quota.js";

function withStore(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "aiwm-quota-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
type Request = {
  id?: number | string;
  method?: string;
  params?: any;
  error?: any;
};
function subprocess(
  handler: (
    request: Request,
    respond: (value: unknown) => void,
    child: any,
  ) => void,
) {
  const requests: Request[] = [];
  let spawns = 0;
  let kills = 0;
  const argsSeen: string[][] = [];
  const spawnProcess: SpawnQuotaProcess = (_command, args) => {
    spawns++;
    argsSeen.push(args);
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      kills++;
      child.exitCode = 0;
      child.emit("close", 0);
      return true;
    };
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        const request = JSON.parse(line);
        requests.push(request);
        queueMicrotask(() =>
          handler(
            request,
            (result: unknown) =>
              child.stdout.write(
                JSON.stringify({ id: request.id, result }) + "\n",
              ),
            child,
          ),
        );
      }
    });
    return child as ChildProcessWithoutNullStreams;
  };
  return {
    spawnProcess,
    requests,
    argsSeen,
    get spawns() {
      return spawns;
    },
    get kills() {
      return kills;
    },
  };
}
const limits = {
  rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } },
  rateLimitsByLimitId: {
    codex: {
      primary: {
        usedPercent: 20,
        windowDurationMins: 10080,
        resetsAt: 1800000000,
      },
      secondary: {
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: 1799999999,
      },
    },
    work: {
      primary: { usedPercent: null, windowDurationMins: 60, resetsAt: null },
      secondary: null,
    },
  },
};
test("MIT-derived window handling keeps dynamic pools/durations and nulls; does not double count legacy", () => {
  const snapshots = quotaSnapshots(
    limits,
    "account",
    "source",
    "2026-10-26T00:00:00Z",
  );
  assert.equal(snapshots.length, 4);
  assert.deepEqual(
    snapshots.map((q) => [q.pool, q.window, q.remainingPercent]),
    [
      ["codex", "10080", 80],
      ["codex", "300", 60],
      ["work", "60", null],
      ["work", "unknown:secondary", null],
    ],
  );
  assert.equal(
    quotaSnapshots(
      {
        rateLimits: {
          primary: { usedPercent: -10, windowDurationMins: 300 },
          secondary: { usedPercent: 140, windowDurationMins: 10080 },
        },
      },
      "a",
      "s",
      "d",
    )[0]?.remainingPercent,
    100,
  );
  assert.equal(
    quotaSnapshots(
      {
        rateLimits: {
          primary: { usedPercent: 140, windowDurationMins: 10080 },
        },
      },
      "a",
      "s",
      "d",
    )[0]?.remainingPercent,
    0,
  );
  assert.throws(() => quotaSnapshots({ rateLimits: null }, "a", "s", "d"));
});
test("RPC uses readonly launch/false refresh; ignores notifications, rejects server requests and never rebinds history", async (t) => {
  const store = withStore(t);
  const fake = subprocess((req, respond, child) => {
    if (req.method === "initialize") {
      child.stdout.write(
        JSON.stringify({
          method: "account/chatgptAuthTokens/refresh",
          id: "refresh-secret",
        }) + "\n",
      );
      child.stdout.write("not-json\n");
      respond({});
    } else if (req.method === "account/read")
      respond({
        account: {
          id: "stable-provider-id",
          email: "DO-NOT-SAVE@example.test",
        },
      });
    else if (req.method === "account/rateLimits/read") {
      child.stdout.write(
        JSON.stringify({
          method: "thread/started",
          params: { status: "active" },
        }) + "\n",
      );
      respond(limits);
    } else if (req.method === "account/usage/read")
      respond({
        summary: { lifetimeTokens: 500, privateSecret: "DROP" },
        dailyUsageBuckets: [{ startDate: "2026-10-26", tokens: 40 }],
      });
  });
  const refresh = createQuotaRefresher({ spawnProcess: fake.spawnProcess });
  assert.deepEqual(await refresh(store), { ok: true });
  assert.deepEqual(fake.argsSeen[0], quotaCommandArgs);
  assert.equal(fake.kills, 1);
  assert.equal(
    fake.requests.find((r) => r.method === "initialize")?.params.clientInfo
      .version,
    appVersion,
  );
  assert.ok(
    fake.requests
      .filter((r) => r.method === "account/read")
      .every((r) => r.params.refreshToken === false),
  );
  assert.ok(
    fake.requests.some(
      (r) => r.id === "refresh-secret" && r.error?.code === -32601,
    ),
  );
  assert.ok(!fake.requests.some((r) => r.method?.startsWith("thread/")));
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) n FROM bindings").get() as any).n,
    0,
  );
  const rows = store.db.prepare("SELECT json FROM quotas").all();
  assert.equal(rows.length, 4);
  assert.ok(
    JSON.stringify(rows).includes("codex:" + hash("stable-provider-id")),
  );
  const settings = JSON.stringify(
    store.db.prepare("SELECT * FROM settings").all(),
  );
  assert.ok(!settings.includes("DO-NOT-SAVE"));
  assert.ok(!settings.includes("DROP"));
  assert.ok(!settings.includes("stable-provider-id"));
});
test("missing stable account ID isolates unknown snapshots each refresh without email-based identity", async (t) => {
  const store = withStore(t);
  let now = Date.now();
  const fake = subprocess((req, respond) => {
    if (req.method === "initialize") respond({});
    else if (req.method === "account/read")
      respond({ account: { type: "chatgpt", email: "same@example.test" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
    else if (req.method === "account/usage/read") respond({ summary: {} });
  });
  const refresh = createQuotaRefresher({
    spawnProcess: fake.spawnProcess,
    now: () => now,
  });
  assert.equal((await refresh(store)).ok, true);
  now += 60_001;
  assert.equal((await refresh(store)).ok, true);
  const accounts = store.db.prepare("SELECT id FROM accounts").all();
  assert.equal(accounts.length, 2);
  assert.ok(accounts.every((a) => String(a.id).startsWith("unknown:codex:")));
  assert.equal(store.accounts().accounts.length, 0);
  assert.equal(store.quotas().length, 4);
  assert.ok(store.quotas().every((q) => (q as any).historyCount === 2));
});
test("guarded quota refresh retains unknown source until login changes and never labels it confirmed", async (t) => {
  const store = withStore(t);
  let now = Date.now(),
    guard = "synthetic-login-one";
  const fake = subprocess((req, respond) => {
    if (req.method === "initialize") respond({});
    else if (req.method === "account/read")
      respond({ account: { type: "chatgpt", email: "unused@example.test" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
    else respond({ summary: {} });
  });
  const refresh = createQuotaRefresher({
    spawnProcess: fake.spawnProcess,
    now: () => now,
    identityGuard: () => guard,
  });
  assert.equal((await refresh(store)).ok, true);
  const first = store.quotas()[0];
  now += 60001;
  assert.equal((await refresh(store)).ok, true);
  assert.equal(store.quotas()[0].accountId, first.accountId);
  assert.equal(store.quotas()[0].sourceId, first.sourceId);
  assert.equal(store.quotas()[0].identityEvidence, "unconfirmed");
  guard = "synthetic-login-two";
  now += 60001;
  assert.equal((await refresh(store)).ok, true);
  assert.notEqual(store.quotas()[0].accountId, first.accountId);
  assert.ok(
    store
      .getSetting<string[]>("inactiveQuotaSources", [])
      .includes(first.sourceId),
  );
});
test("provider identity survives renewed login material and restart; an actual provider switch creates a new source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiwm-provider-renewal-"));
  let store = new Store(dir),
    now = Date.now(),
    provider = "provider-A",
    guard = "login-material-1";
  const fake = subprocess((req, respond) => {
    if (req.method === "account/read")
      respond({ account: { id: provider, email: "same-label@example.test" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
    else respond({});
  });
  const refresh = createQuotaRefresher({
    spawnProcess: fake.spawnProcess,
    now: () => now,
    identityGuard: () => guard,
  });
  try {
    assert.equal((await refresh(store)).ok, true);
    const first = store.quotas()[0];
    guard = "renewed-login-material";
    now += 60001;
    assert.equal((await refresh(store)).ok, true);
    assert.equal(store.quotas()[0].sourceId, first.sourceId);
    assert.equal(store.quotas()[0].accountId, first.accountId);
    assert.equal(store.quotas()[0].identityEvidence, "confirmed");
    store.close();
    store = new Store(dir);
    now += 60001;
    assert.equal((await refresh(store)).ok, true);
    assert.equal(store.quotas()[0].sourceId, first.sourceId);
    provider = "provider-B";
    now += 60001;
    assert.equal((await refresh(store)).ok, true);
    assert.ok(
      store
        .quotas()
        .some(
          (q) =>
            q.accountId === "codex:" + hash("provider-B") &&
            q.sourceId !== first.sourceId,
        ),
    );
    assert.ok(
      store
        .getSetting<string[]>("inactiveQuotaSources", [])
        .includes(first.sourceId),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unknown renewal stays unconfirmed and manual confirmation is bounded to the observed source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiwm-unknown-confirmation-"));
  let store = new Store(dir),
    now = Date.now(),
    guard = "unknown-login-1";
  const fake = subprocess((req, respond) => {
    if (req.method === "account/read")
      respond({ account: { email: "same-label@example.test" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
    else respond({});
  });
  const refresh = createQuotaRefresher({
    spawnProcess: fake.spawnProcess,
    now: () => now,
    identityGuard: () => guard,
  });
  try {
    assert.equal((await refresh(store)).ok, true);
    const first = store.quotas()[0];
    assert.equal(first.identityEvidence, "unconfirmed");
    store.db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .run("manual:mine", "我的账号", "codex", "manual");
    store.createBinding({
      accountId: "manual:mine",
      sourceId: first.sourceId,
      from: first.observedAt,
      to: new Date(now + 86400000).toISOString(),
    });
    assert.equal(store.quotas()[0].accountId, "manual:mine");
    assert.equal(store.quotas()[0].identityEvidence, "manual");
    store.close();
    store = new Store(dir);
    now += 60001;
    assert.equal((await refresh(store)).ok, true);
    assert.equal(store.quotas()[0].accountId, "manual:mine");
    guard = "renewed-or-switched-unknown-login";
    now += 60001;
    assert.equal((await refresh(store)).ok, true);
    const latest = store
      .quotas()
      .filter((q) => q.observedAt === new Date(now).toISOString());
    assert.ok(latest.length > 0);
    assert.ok(
      latest.every(
        (q) =>
          q.sourceId !== first.sourceId &&
          q.accountId?.startsWith("unknown:") &&
          q.identityEvidence === "unconfirmed",
      ),
    );
    assert.ok(
      store
        .getSetting<string[]>("inactiveQuotaSources", [])
        .includes(first.sourceId),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("persistent throttling, single-flight and timeout backoff do not expose stderr or upstream errors", async (t) => {
  const store = withStore(t);
  let now = Date.now();
  const fake = subprocess((req, _respond, child) => {
    if (req.method === "initialize") {
      child.stderr.write("SECRET TOKEN");
      child.stdout.write(
        JSON.stringify({ id: req.id, error: { message: "SECRET TOKEN" } }) +
          "\n",
      );
    }
  });
  const refresh = createQuotaRefresher({
    spawnProcess: fake.spawnProcess,
    now: () => now,
  });
  const [a, b] = await Promise.all([refresh(store), refresh(store)]);
  assert.equal(a.ok, false);
  assert.deepEqual(a, b);
  assert.equal(fake.spawns, 1);
  assert.equal((await refresh(store)).ok, false);
  assert.equal(fake.spawns, 1);
  now += 60_001;
  await refresh(store);
  assert.equal(fake.spawns, 2);
  const state = store.getSetting<any>("quotaRefresh", {});
  assert.equal(state.failures, 2);
  assert.equal(state.nextAllowedAt, now + 120_000);
  assert.ok(!JSON.stringify(state).includes("SECRET"));
  const stalled = subprocess(() => {});
  now += 120_001;
  const timeout = createQuotaRefresher({
    spawnProcess: stalled.spawnProcess,
    now: () => now,
    initializeTimeoutMs: 5,
  });
  assert.equal((await timeout(store)).ok, false);
  assert.equal(stalled.kills, 2);
  assert.equal(
    store.getSetting<any>("quotaRefresh", {}).lastErrorStage,
    "initialize",
  );
  assert.equal(store.getSetting<any>("quotaRefresh", {}).attempts, 2);
});
test("account switch during query discards unbound result instead of attributing to old account", async (t) => {
  const store = withStore(t);
  let reads = 0;
  const fake = subprocess((req, respond) => {
    if (req.method === "initialize") respond({});
    else if (req.method === "account/read")
      respond({ account: { id: ++reads === 1 ? "first" : "second" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
  });
  const result = await createQuotaRefresher({
    spawnProcess: fake.spawnProcess,
  })(store);
  assert.equal(result.ok, false);
  assert.equal(store.quotas().length, 0);
  assert.equal(store.accounts().accounts.length, 0);
});
test("one transient RPC timeout retries a fresh read-only process and saves only the successful attempt", async (t) => {
  for (const phase of [
    "initialize",
    "account/read",
    "account/rateLimits/read",
  ]) {
    const store = withStore(t);
    let attempts = 0;
    const fake = subprocess((req, respond) => {
      if (req.method === "initialize") attempts++;
      if (attempts === 1 && req.method === phase) return;
      if (req.method === "initialize") respond({});
      else if (req.method === "account/read")
        respond({ account: { id: `account-${attempts}` } });
      else if (req.method === "account/rateLimits/read") respond(limits);
      else if (req.method === "account/usage/read") respond({ summary: {} });
    });
    const refresh = createQuotaRefresher({
      spawnProcess: fake.spawnProcess,
      initializeTimeoutMs: 15,
      timeoutMs: 15,
    });
    const [a, b] = await Promise.all([refresh(store), refresh(store)]);
    assert.deepEqual(a, { ok: true }, phase);
    assert.deepEqual(b, a);
    assert.equal(fake.spawns, 2);
    assert.equal(fake.kills, 2);
    assert.equal(store.quotas().length, 4);
    assert.ok(
      store.quotas().every((q) => q.accountId === "codex:" + hash("account-2")),
    );
    assert.equal(store.getSetting<any>("quotaRefresh", {}).failures, 0);
  }
});
test("optional usage failure preserves valid quota while launch errors are redacted", async (t) => {
  const store = withStore(t);
  const fake = subprocess((req, respond, child) => {
    if (req.method === "initialize") respond({});
    else if (req.method === "account/read")
      respond({ account: { type: "chatgpt" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
    else if (req.method === "account/usage/read")
      child.stdout.write(
        JSON.stringify({ id: req.id, error: { message: "SECRET" } }) + "\n",
      );
  });
  assert.equal(
    (await createQuotaRefresher({ spawnProcess: fake.spawnProcess })(store)).ok,
    true,
  );
  const another = withStore(t);
  const failure = await createQuotaRefresher({
    spawnProcess: () => {
      throw Error("Codex SECRET launch error");
    },
  })(another);
  assert.equal(failure.ok, false);
  assert.ok(!failure.error?.includes("SECRET"));
});
test("persistent timeouts share a total deadline; optional usage timeout does not retry successful quota", async (t) => {
  const store = withStore(t);
  const stalled = subprocess(() => {});
  const start = performance.now();
  const result = await createQuotaRefresher({
    spawnProcess: stalled.spawnProcess,
    initializeTimeoutMs: 1000,
    totalTimeoutMs: 25,
  })(store);
  assert.equal(result.ok, false);
  assert.ok(performance.now() - start < 700);
  assert.ok(stalled.spawns <= 2);
  assert.equal(stalled.kills, stalled.spawns);
  assert.equal(store.quotas().length, 0);
  assert.equal(store.getSetting<any>("quotaRefresh", {}).failures, 1);
  const another = withStore(t);
  const fake = subprocess((req, respond) => {
    if (req.method === "initialize") respond({});
    else if (req.method === "account/read")
      respond({ account: { type: "chatgpt" } });
    else if (req.method === "account/rateLimits/read") respond(limits);
  });
  assert.deepEqual(
    await createQuotaRefresher({
      spawnProcess: fake.spawnProcess,
      timeoutMs: 15,
    })(another),
    { ok: true },
  );
  assert.equal(fake.spawns, 1);
  assert.equal(another.quotas().length, 4);
});

test("shutdown cancels a pending quota probe before its deadline without retrying", async (t) => {
  const store = withStore(t),
    child = subprocess(() => {}),
    refresh = createQuotaRefresher({
      spawnProcess: child.spawnProcess,
      initializeTimeoutMs: 20000,
    });
  const pending = refresh(store);
  await refresh.cancel(store);
  assert.equal((await pending).ok, false);
  assert.equal(child.spawns, 1);
  assert.equal(child.kills, 1);
  assert.match(store.getSetting<any>("quotaRefresh", {}).lastError, /关闭/);
});
