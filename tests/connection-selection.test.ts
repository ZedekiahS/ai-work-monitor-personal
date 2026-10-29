import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { SyncClient } from "../collector/sync.js";
import { Connections } from "../collector/connections.js";

type Flow =
  | "resume"
  | "restart-identity"
  | "restart-register"
  | "login"
  | "join"
  | "pair";

async function fixture(flow: Flow) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aiwm-selection-"));
  const store = new Store(dir),
    sync = new SyncClient(store);
  const client = new Connections(store, sync);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const waiting = new Promise<void>((r) => {
    reached = r;
  });
  const blockedRoute =
    flow === "restart-identity" || flow === "login"
      ? "/v1/me"
      : flow === "pair"
        ? "/v1/pair/redeem"
        : flow === "join"
          ? "/v1/join"
          : "/v1/self/register";
  const registrations: any[] = [];
  const service = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === blockedRoute) {
      reached();
      await gate;
    }
    let value: any;
    if (req.url === "/v1/me")
      value = {
        user: { id: "owner" },
        workspaces: [
          { id: "A", name: "Space A", kind: "company", active: true },
        ],
      };
    else if (req.url === "/v1/invites/preview") value = { name: "Space A" };
    else if (req.url === "/v1/join")
      value = {
        productToken: "fixture-recovery",
        userId: "owner",
        workspaceId: "A",
      };
    else if (req.url === "/v1/pair/redeem")
      value = {
        protocolVersion: 1,
        userId: "owner",
        workspaceId: "A",
        kind: "company",
        deviceId: "new-A",
        deviceToken: "fixture-paired-device-proof",
      };
    else if (req.url === "/v1/self/register") {
      registrations.push(body);
      value = {
        protocolVersion: 1,
        userId: "owner",
        workspaceId: "A",
        kind: "company",
        deviceId: "new-A",
        deviceToken: body.registrationToken,
      };
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      service.once("error", reject);
      service.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const url = `http://127.0.0.1:${(service.address() as any).port}`;
  store.setSetting("deviceId", "physical-fixture");
  store.setSetting("environmentId", "environment-fixture");
  const base = {
    url,
    protocolVersion: 1,
    userId: "owner",
    deviceToken: "fixture",
  };
  const a = sync.addConnection({
    ...base,
    workspaceId: "A",
    deviceId: "old-A",
  });
  const b = sync.addConnection({
    ...base,
    workspaceId: "B",
    deviceId: "old-B",
  });
  sync.selectPair(a.id);
  const pending = {
    id: randomUUID(),
    stage: "registering",
    invalid: flow.startsWith("restart"),
    url,
    credential: "fixture-recovery",
    userId: "owner",
    workspaceId: "A",
    name: "Space A",
    registrationId: randomUUID(),
    registrationToken: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  if (flow === "resume" || flow.startsWith("restart"))
    store.setSetting("pendingRegistrations", { [pending.id]: pending });
  return {
    sync,
    store,
    a,
    b,
    waiting,
    release,
    registrations,
    pending,
    start: () =>
      flow === "resume"
        ? client.resume(pending.id)
        : flow === "pair"
          ? sync.pair({ url, code: "fixture-pair-code", name: "Space A" })
          : flow.startsWith("restart")
            ? client.restartRegistration(pending.id, "fixture-recovery")
            : flow === "login"
              ? client.login({
                  url,
                  recoveryCode: "fixture-recovery",
                  workspaceId: "A",
                })
              : client.accept(
                  `aiwm://join?url=${encodeURIComponent(url)}&code=fixture-invitation-code-123456789`,
                  "Owner",
                ),
    async close() {
      release();
      await new Promise<void>((resolve, reject) =>
        service.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const flow of [
  "resume",
  "restart-identity",
  "restart-register",
  "login",
  "join",
  "pair",
] as const)
  for (const selection of ["unchanged", "A-B", "A-B-A"] as const)
    test(`${flow}: late connection is saved and ${selection === "unchanged" ? "normally selected" : `preserves explicit ${selection} selection`}`, async () => {
      const f = await fixture(flow);
      try {
        const operation = f.start();
        await Promise.race([
          f.waiting,
          operation.then((result) => {
            throw Error(
              `fixture request did not reach the held route: ${JSON.stringify(result)}`,
            );
          }),
        ]);
        if (selection !== "unchanged") f.sync.selectPair(f.b.id);
        if (selection === "A-B-A") f.sync.selectPair(f.a.id);
        f.release();
        const result = await operation;
        assert.equal(result.ok, true);
        const newConnection = f.sync
          .connections()
          .find((c) => c.id === result.connectionId);
        assert.equal(
          newConnection?.deviceId,
          "new-A",
          "successful registration remains available even after selection changes",
        );
        assert.equal(f.sync.connections().length, 3);
        assert.equal(
          f.sync.pairInfo()?.id,
          selection === "unchanged"
            ? result.connectionId
            : selection === "A-B"
              ? f.b.id
              : f.a.id,
          "a late registration must not replace a newer explicit selection, including returning to A",
        );
        assert.equal(
          f.store.getSetting<any>("hubPair", null)?.deviceId,
          f.sync.pairInfo()?.deviceId,
        );
        assert.deepEqual(f.store.getSetting("pendingRegistrations", {}), {});
        assert.equal(f.registrations.length, flow === "pair" ? 0 : 1);
        if (flow === "resume")
          assert.equal(
            f.registrations[0].registrationId,
            f.pending.registrationId,
          );
        if (flow.startsWith("restart"))
          assert.notEqual(
            f.registrations[0].registrationId,
            f.pending.registrationId,
          );
      } finally {
        await f.close();
      }
    });
