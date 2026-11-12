import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createBalanceReader } from "../collector/quota-only.js";
function fixture(changes = false) {
  const methods: string[] = [],
    commands: string[][] = [];
  let accounts = 0,
    kills = 0;
  const spawn: any = (_exe: string, args: string[]) => {
    commands.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      kills++;
      child.exitCode = 0;
      child.emit("close");
    };
    child.stdin.on("data", (raw: Buffer) => {
      for (const line of raw.toString().trim().split("\n")) {
        const req = JSON.parse(line);
        methods.push(req.method);
        if (!req.id) continue;
        const result =
          req.method === "initialize"
            ? {}
            : req.method === "account/read"
              ? { account: { id: changes ? String(++accounts) : "one" } }
              : {
                  rateLimits: {
                    primary: {
                      usedPercent: 30,
                      windowDurationMins: 300,
                      resetsAt: 1900000000,
                    },
                  },
                };
        queueMicrotask(() =>
          child.stdout.write(JSON.stringify({ id: req.id, result }) + "\n"),
        );
      }
    });
    return child;
  };
  return {
    spawn,
    methods,
    commands,
    get kills() {
      return kills;
    },
  };
}
test("quota-only reads account and limits only, single flight and throttle, closes own probe", async () => {
  const f = fixture(),
    reader = createBalanceReader(f.spawn);
  const [a, b] = await Promise.all([reader.refresh(), reader.refresh()]);
  assert.deepEqual(a, b);
  assert.equal(a.quotas[0].remainingPercent, 70);
  assert.deepEqual(f.methods, [
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
    "account/read",
  ]);
  await reader.refresh();
  assert.equal(f.commands.length, 1);
  assert.ok(f.commands[0].includes("read-only"));
  assert.ok(f.commands[0].includes("features.hooks=false"));
  assert.equal(f.kills, 1);
  await reader.close();
});
test("changing account and spawn failures never display guessed balance", async () => {
  const f = fixture(true),
    reader = createBalanceReader(f.spawn);
  const state = await reader.refresh();
  assert.equal(state.quotas.length, 0);
  assert.ok(state.error);
  assert.equal(state.busy, false);
  await reader.close();
  const fail = createBalanceReader(() => {
    throw Error("private-secret");
  });
  const failure = await fail.refresh();
  assert.equal(failure.busy, false);
  assert.equal(failure.quotas.length, 0);
  assert.ok(!failure.error.includes("private-secret"));
  await fail.close();
});
