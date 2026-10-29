import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../core/store.js";
import { SyncClient } from "../collector/sync.js";
import { Connections } from "../collector/connections.js";

async function fixture() {
  const requests: { route: string; body: any; authorization?: string }[] = [];
  let consumed = false,
    failRegistration = false,
    loseRegistrationResponse = false,
    loseJoinResponse = false;
  let joinedProof: any, invalidRegistration: string | undefined;
  let lastRegistration: string | undefined;
  let device: any;
  let rotationGate: Promise<void> | undefined;
  let releaseRotation: (() => void) | undefined;
  let joinGate: Promise<void> | undefined,
    releaseJoin: (() => void) | undefined;
  const service = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const route = req.url!;
    requests.push({ route, body, authorization: req.headers.authorization });
    const send = (code: number, value: any) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (route === "/v1/invites/preview")
      return send(consumed ? 400 : 200, { name: "工作空间 A" });
    if (route === "/v1/join") {
      if (
        consumed &&
        (!body.joinId ||
          body.joinId !== joinedProof?.joinId ||
          body.joinProof !== joinedProof?.joinProof)
      )
        return send(400, { error: "used" });
      consumed = true;
      joinedProof = { joinId: body.joinId, joinProof: body.joinProof };
      if (loseJoinResponse) {
        loseJoinResponse = false;
        req.socket.destroy();
        return;
      }
      await joinGate;
      return send(200, {
        productToken: req.headers.authorization
          ? undefined
          : "fixture-product-recovery",
        userId: "user",
        workspaceId: "A",
      });
    }
    if (route === "/v1/self/register") {
      if (failRegistration) return send(503, { error: "unavailable" });
      if (body.registrationId === invalidRegistration)
        return send(409, { error: "revoked or rotated" });
      if (lastRegistration && lastRegistration !== body.registrationId)
        device = undefined;
      lastRegistration = body.registrationId;
      device ??= {
        protocolVersion: 1,
        deviceToken: body.registrationToken ?? "fixture-device",
        deviceId: "registered-device",
        workspaceId: "A",
        userId:
          req.headers.authorization === "Bearer wrong-person"
            ? "other-user"
            : "user",
        kind: "company",
      };
      if (loseRegistrationResponse) {
        loseRegistrationResponse = false;
        req.socket.destroy();
        return;
      }
      return send(200, device);
    }
    if (route === "/v1/me")
      return send(200, {
        user: {
          id:
            req.headers.authorization === "Bearer wrong-person"
              ? "other-user"
              : "user",
        },
        workspaces: [{ id: "A", name: "工作空间 A", kind: "company" }],
      });
    if (route.endsWith("/rotate")) {
      await rotationGate;
      return send(200, { deviceToken: "fixture-rotated-device" });
    }
    if (route.startsWith("/v1/self/devices"))
      return send(200, { items: [{ id: "registered-device" }] });
    if (route === "/v1/self/pair-codes")
      return send(200, {
        code: "fixture-pair-code-123456789",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (route === "/v1/self/recovery")
      return send(200, { productToken: "fixture-rotated-recovery" });
    send(404, {});
  });
  await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (service.address() as any).port;
  const dir = mkdtempSync(path.join(os.tmpdir(), "awm-connection-"));
  let store = new Store(dir);
  store.setSetting("deviceId", "physical-device");
  store.setSetting("environmentId", "environment");
  let sync = new SyncClient(store),
    client = new Connections(store, sync);
  return {
    get store() {
      return store;
    },
    get sync() {
      return sync;
    },
    get client() {
      return client;
    },
    url,
    requests,
    link: `aiwm://join?url=${encodeURIComponent(url)}&code=fixture-invitation-code-123456789`,
    fail(value: boolean) {
      failRegistration = value;
    },
    loseResponse() {
      loseRegistrationResponse = true;
    },
    loseJoin() {
      loseJoinResponse = true;
    },
    invalidateRegistration() {
      invalidRegistration = lastRegistration;
    },
    holdRotation() {
      rotationGate = new Promise((r) => {
        releaseRotation = r;
      });
    },
    releaseRotation() {
      releaseRotation?.();
    },
    holdJoin() {
      joinGate = new Promise((r) => {
        releaseJoin = r;
      });
    },
    releaseJoin() {
      releaseJoin?.();
    },
    restart() {
      store.close();
      store = new Store(dir);
      sync = new SyncClient(store);
      client = new Connections(store, sync);
    },
    async close() {
      store.close();
      await new Promise<void>((r) => service.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("confirmed receiver survives A-B-A and rejects requests submitted after another window switches", async () => {
  const f = await fixture();
  try {
    const base = {
      url: f.url,
      deviceToken: "fixture",
      userId: "user",
      protocolVersion: 1,
    };
    const a = f.sync.addConnection({
      ...base,
      workspaceId: "A",
      deviceId: "a",
    });
    const b = f.sync.addConnection({
      ...base,
      workspaceId: "B",
      deviceId: "b",
    });
    await assert.rejects(
      () => (f.client as any).own("devices", "GET", undefined, a.id),
      /接收方|连接.*变|目标/,
    );
    assert.equal(f.requests.length, 0);
    f.sync.selectPair(a.id);
    const devices = await (f.client as any).own(
      "devices",
      "GET",
      undefined,
      a.id,
    );
    assert.equal(devices.connectionId, a.id);
    assert.match(f.requests[0].route, /workspaceId=A/);
    f.sync.selectPair(b.id);
    await assert.rejects(
      () => (f.client as any).pairCode(a.id),
      /接收方|连接.*变|目标/,
    );
    await assert.rejects(
      () => (f.client as any).own("devices", "GET"),
      /接收方|连接.*变|目标/,
    );
  } finally {
    await f.close();
  }
});

test("join commit response loss retains its own encrypted proof before request and resumes after restart", async () => {
  const f = await fixture();
  try {
    f.loseJoin();
    const result = await f.client.accept(f.link, "本人");
    assert.equal(result.pending, true);
    assert.equal(result.stage, "joining");
    const sent = f.requests.find((r) => r.route === "/v1/join")!.body;
    assert.match(sent.joinId, /^[0-9a-f-]{36}$/);
    assert.match(sent.joinProof, /^[a-zA-Z0-9_-]{43}$/);
    const saved = Object.values(
      f.store.getSetting<any>("pendingRegistrations", {}),
    ) as any[];
    assert.equal(saved[0].joinId, sent.joinId);
    assert.equal(saved[0].joinProof, sent.joinProof);
    assert.ok(
      !JSON.stringify(
        f.store.db.prepare("SELECT value FROM settings").all(),
      ).includes(sent.joinProof),
    );
    assert.throws(
      () => f.client.savedRecovery(undefined, result.pendingId),
      /加入|确认|继续/,
    );
    f.restart();
    const resumed = await f.client.resume(result.pendingId);
    assert.equal(resumed.ok, true);
    const joins = f.requests.filter((r) => r.route === "/v1/join");
    assert.equal(joins.length, 2);
    assert.deepEqual(joins[1].body, joins[0].body);
    assert.equal(f.sync.connections().length, 1);
    assert.equal(f.client.pending().items.length, 0);
  } finally {
    await f.close();
  }
});

test("late authenticated join cannot overwrite a product recovery credential rotated while its response waits", async () => {
  const f = await fixture();
  try {
    const connection = f.sync.addConnection({
      url: f.url,
      deviceToken: "fixture-device",
      deviceId: "before-join",
      workspaceId: "A",
      userId: "user",
      protocolVersion: 1,
    });
    f.store.setSetting("productIdentities", {
      [f.url]: { userId: "user", token: "fixture-before-rotation" },
    });
    f.holdJoin();
    const accepting = f.client.accept(f.link, "本人");
    for (
      let i = 0;
      i < 100 && !f.requests.some((r) => r.route === "/v1/join");
      i++
    )
      await delay(5);
    assert.ok(f.requests.some((r) => r.route === "/v1/join"));
    await f.client.recovery(connection.id);
    assert.equal(
      (
        Object.values(
          f.store.getSetting<any>("pendingRegistrations", {}),
        )[0] as any
      ).credential,
      "fixture-rotated-recovery",
    );
    f.releaseJoin();
    const result = await accepting;
    assert.equal(result.ok, true);
    assert.equal(
      f.requests.find((r) => r.route === "/v1/self/register")?.authorization,
      "Bearer fixture-rotated-recovery",
    );
    assert.equal(
      f.store.getSetting<any>("productIdentities", {})[f.url].token,
      "fixture-rotated-recovery",
    );
    assert.equal(
      f.client.savedRecovery(result.connectionId).recoveryCode,
      "fixture-rotated-recovery",
    );
  } finally {
    f.releaseJoin();
    await f.close();
  }
});

for (const authenticated of [false, true])
  test(`late ${authenticated ? "authenticated" : "anonymous"} join preserves a newer explicit login for another user and retains its own proof`, async () => {
    const f = await fixture();
    try {
      if (authenticated)
        f.store.setSetting("productIdentities", {
          [f.url]: { userId: "user", token: "fixture-old-user" },
        });
      f.holdJoin();
      const accepting = f.client.accept(f.link, "本人");
      for (
        let i = 0;
        i < 100 && !f.requests.some((r) => r.route === "/v1/join");
        i++
      )
        await delay(5);
      assert.ok(f.requests.some((r) => r.route === "/v1/join"));
      const before = Object.values(
        f.store.getSetting<any>("pendingRegistrations", {}),
      ).find((v: any) => v.stage === "joining") as any;
      const newer = await f.client.login({
        url: f.url,
        recoveryCode: "wrong-person",
        workspaceId: "A",
      });
      assert.equal(newer.ok, true);
      f.releaseJoin();
      const result = await accepting;
      assert.equal(result.ok, false);
      assert.equal(result.stage, "joining");
      assert.match(result.error, /身份.*改变/);
      assert.deepEqual(
        f.store.getSetting<any>("productIdentities", {})[f.url],
        { userId: "other-user", token: "wrong-person" },
      );
      assert.equal(f.sync.pairInfo()?.userId, "other-user");
      const after = f.store.getSetting<any>("pendingRegistrations", {})[
        before.id
      ];
      assert.equal(after.joinId, before.joinId);
      assert.equal(after.joinProof, before.joinProof);
      assert.equal(
        f.requests.filter((r) => r.route === "/v1/self/register").length,
        1,
        "old join must not register using the other identity",
      );
    } finally {
      f.releaseJoin();
      await f.close();
    }
  });

test("revoked or rotated pending requires explicit verified identity before fresh registration; network retry preserves proof", async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    const first = await f.client.accept(f.link, "本人");
    const before = f.requests.find(
      (r) => r.route === "/v1/self/register",
    )!.body;
    f.invalidateRegistration();
    const failed = await f.client.resume(first.pendingId);
    assert.equal(failed.invalid, true);
    assert.equal(failed.pending, true);
    const requestsBefore = f.requests.length;
    await f.client.resume(first.pendingId);
    assert.equal(
      f.requests.length,
      requestsBefore,
      "invalid proof must not retry 409 forever",
    );
    const still = await f.client.login({
      url: f.url,
      recoveryCode: first.recoveryCode,
      workspaceId: "A",
    });
    assert.equal(
      still.invalid,
      true,
      "ordinary login must not silently replace the original intent",
    );
    await assert.rejects(
      () =>
        (f.client as any).restartRegistration(first.pendingId, "wrong-person"),
      /本人|身份|账号/,
    );
    assert.equal(f.client.pending().items.length, 1);
    const recovered = await (f.client as any).restartRegistration(
      first.pendingId,
      first.recoveryCode,
    );
    assert.equal(recovered.ok, true);
    const sent = f.requests
      .filter((r) => r.route === "/v1/self/register")
      .map((r) => r.body);
    assert.equal(sent[1].registrationId, before.registrationId);
    assert.equal(sent[1].registrationToken, before.registrationToken);
    assert.notEqual(sent.at(-1).registrationId, before.registrationId);
    assert.notEqual(sent.at(-1).registrationToken, before.registrationToken);
    assert.equal(f.client.pending().items.length, 0);
  } finally {
    await f.close();
  }
});

test("another device revocation requires matching product identity; a paired device can revoke itself", async () => {
  const f = await fixture();
  try {
    const a = f.sync.addConnection({
      url: f.url,
      deviceToken: "fixture-device-only",
      userId: "user",
      protocolVersion: 1,
      workspaceId: "A",
      deviceId: "a",
    });
    await assert.rejects(
      () => f.client.own("devices/b", "DELETE", undefined, a.id),
      /恢复码/,
    );
    f.store.setSetting("productIdentities", {
      [f.url]: { userId: "another-user", token: "fixture-other-user" },
    });
    await assert.rejects(
      () => f.client.own("devices/b", "DELETE", undefined, a.id),
      /恢复码/,
    );
    f.store.setSetting("productIdentities", {
      [f.url]: { userId: "user", token: "fixture-product" },
    });
    await f.client.own("devices/b", "DELETE", undefined, a.id);
    assert.equal(f.requests.at(-1)?.authorization, "Bearer fixture-product");
    assert.match(f.requests.at(-1)!.route, /workspaceId=A/);
    f.store.setSetting("productIdentities", {});
    await f.client.own("devices/a", "DELETE", undefined, a.id);
    assert.equal(
      f.requests.at(-1)?.authorization,
      "Bearer fixture-device-only",
    );
  } finally {
    await f.close();
  }
});

test("late device rotation updates its confirmed receiver without changing the newly selected target", async () => {
  const f = await fixture();
  try {
    const base = {
      url: f.url,
      deviceToken: "fixture",
      userId: "user",
      protocolVersion: 1,
    };
    const a = f.sync.addConnection({
      ...base,
      workspaceId: "A",
      deviceId: "a",
    });
    const b = f.sync.addConnection({
      ...base,
      workspaceId: "B",
      deviceId: "b",
    });
    f.sync.selectPair(a.id);
    f.holdRotation();
    const rotation = f.client.rotate(a.id);
    for (
      let i = 0;
      i < 100 && !f.requests.some((r) => r.route.endsWith("/rotate"));
      i++
    )
      await delay(5);
    assert.ok(f.requests.some((r) => r.route.endsWith("/rotate")));
    f.sync.selectPair(b.id);
    f.releaseRotation();
    const result = await rotation;
    assert.equal(result.connectionId, a.id);
    assert.equal(f.sync.pairInfo()!.id, b.id);
    assert.equal(
      f.sync.connections().find((c) => c.id === a.id)?.deviceToken,
      "fixture-rotated-device",
    );
  } finally {
    f.releaseRotation();
    await f.close();
  }
});

test("join followed by register failure persists recovery and resumes after restart without consuming invite twice", async () => {
  const f = await fixture();
  try {
    f.fail(true);
    const result = await f.client.accept(f.link, "员工");
    assert.equal(result.pending, true);
    assert.equal(result.recoveryCode, "fixture-product-recovery");
    assert.equal((f.client as any).pending().items.length, 1);
    assert.ok(
      !JSON.stringify(
        f.store.db.prepare("SELECT value FROM settings").all(),
      ).includes("fixture-product-recovery"),
    );
    const registrationToken = f.requests.find(
      (r) => r.route === "/v1/self/register",
    )!.body.registrationToken;
    assert.ok(
      !JSON.stringify(
        f.store.db.prepare("SELECT value FROM settings").all(),
      ).includes(registrationToken),
    );
    f.restart();
    f.fail(false);
    const resumed = await f.client.accept(f.link, "员工");
    assert.equal(resumed.ok, true);
    assert.equal(f.sync.connections().length, 1);
    assert.equal(f.requests.filter((r) => r.route === "/v1/join").length, 1);
    assert.equal((f.client as any).pending().items.length, 0);
  } finally {
    await f.close();
  }
});

test("lost registration response reuses persisted registration proof and recovery remains retrievable", async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    const result = await f.client.accept(f.link, "员工");
    assert.equal(result.pending, true);
    f.restart();
    const resumed = await (f.client as any).resume(result.pendingId);
    assert.equal(resumed.ok, true);
    const sent = f.requests
      .filter((r) => r.route === "/v1/self/register")
      .map((r) => r.body);
    assert.equal(sent.length, 2);
    assert.match(sent[0].registrationId, /^[0-9a-f-]{36}$/);
    assert.ok(sent[0].registrationToken.length >= 40);
    assert.equal(sent[0].registrationId, sent[1].registrationId);
    assert.equal(sent[0].registrationToken, sent[1].registrationToken);
    const connectionId = f.sync.pairInfo()!.id;
    assert.equal(
      (f.client as any).savedRecovery(connectionId).recoveryCode,
      "fixture-product-recovery",
    );
    await (f.client as any).recovery(connectionId);
    f.restart();
    assert.equal(
      (f.client as any).savedRecovery(connectionId).recoveryCode,
      "fixture-rotated-recovery",
    );
  } finally {
    await f.close();
  }
});

test(
  "local HTTP rejects stale receiver for reads, credentials, sharing, pause and revoke",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const dir = mkdtempSync(path.join(os.tmpdir(), "awm-receiver-http-"));
    const source = path.join(dir, "source");
    mkdirSync(path.join(source, "sessions"), { recursive: true });
    const store = new Store(path.join(dir, "monitor")),
      sync = new SyncClient(store);
    const basePair = {
      url: f.url,
      deviceToken: "fixture",
      userId: "user",
      protocolVersion: 1,
    };
    const a = sync.addConnection({
      ...basePair,
      deviceId: "a",
      workspaceId: "A",
    });
    const b = sync.addConnection({
      ...basePair,
      deviceId: "b",
      workspaceId: "B",
    });
    sync.selectPair(a.id);
    store.db.prepare("INSERT INTO grants VALUES(?,?,0)").run(
      "grant-a",
      JSON.stringify({
        id: "grant-a",
        connectionId: a.id,
        workspaceId: "A",
        accountIds: [],
        projectIds: [],
        from: "2026-01-01T00:00:00Z",
        to: "2030-01-01T00:00:00Z",
      }),
    );
    const invalidPendingId = randomUUID();
    store.setSetting("pendingRegistrations", {
      [invalidPendingId]: {
        id: invalidPendingId,
        stage: "registering",
        invalid: true,
        url: f.url,
        credential: "fixture-product-recovery",
        userId: "user",
        workspaceId: "A",
        name: "工作空间 A",
        registrationId: randomUUID(),
        registrationToken: randomBytes(32).toString("base64url"),
        createdAt: new Date().toISOString(),
      },
    });
    store.close();
    const portProbe = http.createServer();
    await new Promise<void>((r) => portProbe.listen(0, "127.0.0.1", r));
    const port = (portProbe.address() as any).port;
    await new Promise<void>((r) => portProbe.close(() => r()));
    const token = "receiver-test-local-token";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AIWM_DATA_DIR: path.join(dir, "monitor"),
          CODEX_HOME: source,
          AIWM_QUOTA_DISABLED: "1",
          AIWM_PORT: String(port),
          AIWM_LAUNCH_TOKEN: token,
        },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const request = async (route: string, method = "GET", body?: any) => {
      const r = await fetch(`http://127.0.0.1:${port}` + route, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    };
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await request("/api/sharing")).status === 200;
          if (ready) break;
        } catch {}
        await delay(100);
      }
      assert.equal(ready, true);
      assert.equal(
        (await request("/api/sync/select", "POST", { id: b.id })).status,
        200,
      );
      const oldTarget = "?connectionId=" + encodeURIComponent(a.id);
      for (const route of ["devices", "overview", "records", "recovery"])
        assert.equal(
          (await request("/api/connections/" + route + oldTarget)).status,
          400,
          route,
        );
      for (const route of ["pair-code", "rotate", "recovery"])
        assert.equal(
          (
            await request("/api/connections/" + route, "POST", {
              connectionId: a.id,
            })
          ).status,
          400,
          route,
        );
      assert.equal(
        (await request("/api/connections/devices/a" + oldTarget, "DELETE"))
          .status,
        400,
      );
      assert.equal(
        (
          await request("/api/sharing", "POST", {
            connectionId: a.id,
            accountIds: [],
            projectIds: [],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/api/sharing/grant-a/pause", "POST", {
            connectionId: a.id,
            paused: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (await request("/api/sharing/grant-a" + oldTarget, "DELETE")).status,
        400,
      );
      assert.equal(
        (await request("/api/sync/select", "POST", { id: a.id })).status,
        200,
      );
      const devices = await request("/api/connections/devices" + oldTarget);
      assert.equal(devices.status, 200);
      assert.equal(devices.data.connectionId, a.id);
      assert.equal(
        (
          await request("/api/connections/devices/a", "DELETE", {
            connectionId: a.id,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request("/api/connections/devices/a" + oldTarget, "DELETE", {
            connectionId: b.id,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/api/connections/restart-registration", "POST", {
            pendingId: invalidPendingId,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/api/connections/restart-registration", "POST", {
            pendingId: invalidPendingId,
            recoveryCode: "wrong-person",
          })
        ).status,
        400,
      );
      assert.equal(
        (await request("/api/connections/pending")).data.items.length,
        1,
      );
      const recovered = await request(
        "/api/connections/restart-registration",
        "POST",
        {
          pendingId: invalidPendingId,
          recoveryCode: "fixture-product-recovery",
        },
      );
      assert.equal(recovered.status, 200);
      assert.equal(recovered.data.ok, true);
      assert.equal(
        (await request("/api/connections/pending")).data.items.length,
        0,
      );
    } finally {
      child.kill();
      if (child.exitCode === null)
        await new Promise<void>((r) => child.once("exit", () => r()));
      await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
