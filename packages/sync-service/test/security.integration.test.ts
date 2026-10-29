import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { SyncService, hash } from "../src/kernel.js";

const pg =
  process.env.SYNC_TEST_DATABASE_URL ?? process.env.HUB_TEST_DATABASE_URL;
const enabled =
  (process.env.SYNC_RUN_DB_TESTS ?? process.env.HUB_RUN_DB_TESTS) === "1" &&
  !!pg;
test(
  "device principal, pairing revocation, registration retry and heartbeat scope",
  { skip: !enabled },
  async (t) => {
    const admin = new Pool({ connectionString: pg }),
      schema = "security_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new URL(pg!);
    db.searchParams.set("options", "-csearch_path=" + schema);
    const service = new SyncService({ connectionString: db.toString() }),
      owner = randomBytes(32).toString("base64url");
    await service.init({ token: owner });
    const server = createServer(service.handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = "http://127.0.0.1:" + (server.address() as any).port;
    const api = async (
      route: string,
      credential = owner,
      method = "GET",
      body?: any,
    ) => {
      const response = await fetch(url + route, {
        method,
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const w = (await service.pool.query("SELECT id FROM workspaces")).rows[0]
      .id;
    const register = () =>
      api("/v1/self/register", owner, "POST", {
        workspaceId: w,
        label: "Device",
        deviceId: randomUUID(),
        environmentId: randomUUID(),
      });
    try {
      await t.test(
        "device A cannot rotate B, self rotation invalidates old token and leaves B intact",
        async () => {
          const a = (await register()).body,
            b = (await register()).body;
          assert.equal(
            (
              await api(
                `/v1/self/devices/${b.deviceId}/rotate`,
                a.deviceToken,
                "POST",
                {},
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await api(
                `/v1/self/devices/${b.deviceId}`,
                a.deviceToken,
                "DELETE",
              )
            ).status,
            403,
          );
          const next = await api(
            `/v1/self/devices/${a.deviceId}/rotate`,
            a.deviceToken,
            "POST",
            {},
          );
          assert.equal(next.status, 200);
          assert.equal(
            (await api("/v1/self/devices", a.deviceToken)).status,
            401,
          );
          assert.equal(
            (await api("/v1/self/devices", next.body.deviceToken)).status,
            200,
          );
          assert.equal(
            (await api("/v1/self/devices", b.deviceToken)).status,
            200,
          );
          const managed = await api(
            `/v1/self/devices/${b.deviceId}/rotate?workspaceId=${w}`,
            owner,
            "POST",
            {},
          );
          assert.equal(managed.status, 200);
          assert.equal(
            (await api("/v1/self/devices", b.deviceToken)).status,
            401,
          );
          assert.equal(
            (await api("/v1/self/devices", managed.body.deviceToken)).status,
            200,
          );
        },
      );
      await t.test(
        "revoking issuer invalidates unconsumed pairing codes including preview",
        async () => {
          const a = (await register()).body;
          const code = (
            await api("/v1/self/pair-codes", a.deviceToken, "POST", {
              workspaceId: w,
              label: "New device",
            })
          ).body.code;
          assert.equal(
            (
              await api(
                `/v1/self/devices/${a.deviceId}?workspaceId=${w}`,
                owner,
                "DELETE",
              )
            ).status,
            200,
          );
          assert.equal(
            (await api("/v1/pair/preview", owner, "POST", { code })).status,
            400,
          );
          assert.equal(
            (
              await api("/v1/pair/redeem", owner, "POST", {
                code,
                label: "New",
                deviceId: randomUUID(),
                environmentId: randomUUID(),
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        "lost register response retries one durable device and cannot revive revoked registration",
        async () => {
          const body = {
            workspaceId: w,
            label: "Retry",
            deviceId: randomUUID(),
            environmentId: randomUUID(),
            registrationId: randomUUID(),
            registrationToken: randomBytes(32).toString("base64url"),
          };
          const [first, repeated] = await Promise.all([
            api("/v1/self/register", owner, "POST", body),
            api("/v1/self/register", owner, "POST", body),
          ]);
          assert.equal(first.status, 201);
          assert.equal(repeated.status, 201);
          assert.equal(first.body.deviceId, repeated.body.deviceId);
          assert.equal(first.body.deviceToken, repeated.body.deviceToken);
          assert.equal(
            (
              await service.pool.query(
                "SELECT count(*)::int n FROM devices WHERE physical_id=$1",
                [body.deviceId],
              )
            ).rows[0].n,
            1,
          );
          await api(
            `/v1/self/devices/${first.body.deviceId}?workspaceId=${w}`,
            owner,
            "DELETE",
          );
          assert.equal(
            (await api("/v1/self/register", owner, "POST", body)).status,
            409,
          );
        },
      );
      await t.test(
        "unscoped or stale heartbeat never exposes current task activity",
        async () => {
          const a = (await register()).body;
          assert.equal(
            (
              await api("/v1/heartbeat", a.deviceToken, "POST", {
                collectorHealth: "healthy",
                taskState: "running",
              })
            ).status,
            200,
          );
          const devices = (await api("/v1/self/devices?workspaceId=" + w)).body
            .devices;
          assert.equal(
            devices.find((d: any) => d.id === a.deviceId).taskState,
            null,
          );
        },
      );
      await t.test(
        "activity needs a live matching project grant; expiry, clear and withdrawal hide old running state",
        async () => {
          const a = (await register()).body;
          const now = Date.now(),
            spec = {
              workspaceId: w,
              accountIds: ["a"],
              projectIds: ["work"],
              shareQuota: true,
              from: new Date(now - 3600000).toISOString(),
              to: new Date(now + 3600000).toISOString(),
              retentionDays: 30,
            };
          const g = (await api("/v1/grants", owner, "POST", spec)).body;
          const activity = {
            grantId: g.id,
            accountId: "a",
            projectId: "work",
            occurredAt: new Date().toISOString(),
          };
          let heartbeatSeq = 0;
          const heartbeat = (proof: any) =>
            api("/v1/heartbeat", a.deviceToken, "POST", {
              collectorHealth: "healthy",
              taskState: "running",
              taskActivity: proof,
              heartbeatSeq: ++heartbeatSeq,
            });
          const state = async () =>
            (await api("/v1/self/devices?workspaceId=" + w)).body.devices.find(
              (d: any) => d.id === a.deviceId,
            ).taskState;
          for (const proof of [
            { ...activity, projectId: "private" },
            { ...activity, accountId: "b" },
            { ...activity, occurredAt: new Date(now - 16000).toISOString() },
          ]) {
            assert.equal((await heartbeat(proof)).status, 200);
            assert.equal(await state(), null);
          }
          assert.equal((await heartbeat(activity)).status, 200);
          assert.equal(await state(), "running");
          await api("/v1/heartbeat", a.deviceToken, "POST", {
            collectorHealth: "healthy",
            heartbeatSeq: ++heartbeatSeq,
          });
          assert.equal(await state(), null);
          await heartbeat(activity);
          await service.pool.query(
            "UPDATE devices SET task_state_at=now()-interval '16 seconds' WHERE id=$1",
            [a.deviceId],
          );
          assert.equal(await state(), null);
          await heartbeat(activity);
          await service.pool.query(
            "UPDATE grants SET ends_at=now()-interval '1 second' WHERE id=$1",
            [g.id],
          );
          assert.equal(await state(), null);
          await service.pool.query(
            "UPDATE grants SET ends_at=now()+interval '1 hour' WHERE id=$1",
            [g.id],
          );
          await heartbeat(activity);
          await api("/v1/grants/" + g.id, owner, "DELETE");
          assert.equal(await state(), null);
          assert.equal((await heartbeat(activity)).status, 200);
          assert.equal(await state(), null);
        },
      );
      await t.test(
        "delayed pre-pause running heartbeat cannot overwrite a newer activity clear",
        async () => {
          const a = (await register()).body,
            now = Date.now();
          const g = (
            await api("/v1/grants", owner, "POST", {
              workspaceId: w,
              accountIds: ["a"],
              projectIds: ["p"],
              from: new Date(now - 60000).toISOString(),
              to: new Date(now + 60000).toISOString(),
              shareQuota: false,
              retentionDays: 30,
            })
          ).body;
          const running = {
            collectorHealth: "healthy",
            heartbeatSeq: 1,
            taskState: "running",
            taskActivity: {
              grantId: g.id,
              accountId: "a",
              projectId: "p",
              occurredAt: new Date(now).toISOString(),
            },
          };
          assert.equal(
            (await api("/v1/heartbeat", a.deviceToken, "POST", running)).status,
            200,
          );
          assert.equal(
            (
              await api("/v1/heartbeat", a.deviceToken, "POST", {
                collectorHealth: "healthy",
                heartbeatSeq: 2,
              })
            ).status,
            200,
          );
          assert.equal(
            (await api("/v1/heartbeat", a.deviceToken, "POST", running)).status,
            200,
          );
          const state = (
            await api("/v1/self/devices?workspaceId=" + w)
          ).body.devices.find((d: any) => d.id === a.deviceId).taskState;
          assert.equal(state, null);
        },
      );
      await t.test(
        "legacy unproven pairing code is rejected without mutating it; new product-issued code survives migration",
        async () => {
          const code = randomBytes(32).toString("base64url");
          const user = (
            await service.pool.query("SELECT id FROM product_users LIMIT 1")
          ).rows[0].id;
          await service.pool.query(
            "INSERT INTO pair_codes(code_hash,workspace_id,user_id,label,expires_at) VALUES($1,$2,$3,'Legacy',now()+interval '10 minutes')",
            [hash(code), w, user],
          );
          await service.init();
          assert.equal(
            (await api("/v1/pair/preview", owner, "POST", { code })).status,
            409,
          );
          assert.equal(
            (
              await api("/v1/pair/redeem", owner, "POST", {
                code,
                label: "New",
                deviceId: randomUUID(),
                environmentId: randomUUID(),
              })
            ).status,
            409,
          );
          const original = (
            await service.pool.query(
              "SELECT revoked_at,redeemed_at FROM pair_codes WHERE code_hash=$1",
              [hash(code)],
            )
          ).rows[0];
          assert.equal(original.revoked_at, null);
          assert.equal(original.redeemed_at, null);
          const next = (
            await api("/v1/self/pair-codes", owner, "POST", {
              workspaceId: w,
              label: "Product",
            })
          ).body.code;
          await service.init();
          assert.equal(
            (await api("/v1/pair/preview", owner, "POST", { code: next }))
              .status,
            200,
          );
          assert.equal(
            (
              await api("/v1/pair/redeem", owner, "POST", {
                code: next,
                label: "New",
                deviceId: randomUUID(),
                environmentId: randomUUID(),
              })
            ).status,
            201,
          );
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await service.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
