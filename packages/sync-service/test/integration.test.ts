import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SyncService } from "../src/kernel.js";
import { Store } from "../../../core/store.js";
import { SyncClient } from "../../../collector/sync.js";
import { Connections } from "../../../collector/connections.js";
const enabled =
  (process.env.SYNC_RUN_DB_TESTS ?? process.env.HUB_RUN_DB_TESTS) === "1" &&
  !!(process.env.SYNC_TEST_DATABASE_URL ?? process.env.HUB_TEST_DATABASE_URL);
test(
  "public personal service: own identity, two independent devices, offline outbox and authorized metadata without enterprise code",
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const pg = (process.env.SYNC_TEST_DATABASE_URL ??
        process.env.HUB_TEST_DATABASE_URL)!,
      admin = new Pool({ connectionString: pg }),
      schema = "personal_test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new URL(pg);
    db.searchParams.set("options", "-csearch_path=" + schema);
    const service = new SyncService({ connectionString: db.toString() }),
      owner = randomUUID() + randomUUID();
    await service.init({ token: owner });
    const server = createServer(service.handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port,
      url = "http://127.0.0.1:" + port;
    let listening = true;
    const stores: Store[] = [];
    const client = () => {
      mkdirSync("work/personal-sync-tests", { recursive: true });
      const store = new Store(
        mkdtempSync(path.resolve("work/personal-sync-tests/client-")),
      );
      store.setSetting("deviceId", randomUUID());
      store.setSetting("environmentId", randomUUID());
      stores.push(store);
      const sync = new SyncClient(store);
      return { store, sync, connect: new Connections(store, sync) };
    };
    const api = async (
      route: string,
      credential = owner,
      method = "GET",
      body?: any,
    ) => {
      const r = await fetch(url + route, {
        method,
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const a = client(),
      b = client();
    try {
      await t.test(
        "personal schema has no memberships or invitations; company management is absent",
        async () => {
          const tables = (
            await service.pool.query(
              "SELECT tablename FROM pg_tables WHERE schemaname=$1",
              [schema],
            )
          ).rows.map((x) => x.tablename);
          assert.ok(!tables.includes("memberships"));
          assert.ok(!tables.includes("invites"));
          assert.equal(
            (
              await api("/v1/workspaces", owner, "POST", {
                kind: "company",
                name: "Not allowed",
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        "first device login and second-device pair preserve one owner and distinct credentials",
        async () => {
          assert.equal(
            (
              await a.connect.login({
                url,
                recoveryCode: owner,
                personal: true,
              })
            ).ok,
            true,
          );
          const link = (await a.connect.pairCode(a.sync.pairInfo()!.id)).link;
          const preview = await b.connect.preview(link);
          assert.equal(preview.kind, "device");
          await b.connect.accept(link, "");
          assert.equal(a.sync.pairInfo()!.userId, b.sync.pairInfo()!.userId);
          assert.notEqual(
            a.sync.pairInfo()!.deviceId,
            b.sync.pairInfo()!.deviceId,
          );
          assert.notEqual(
            a.sync.pairInfo()!.deviceToken,
            b.sync.pairInfo()!.deviceToken,
          );
          const raw = JSON.stringify(
            a.store.db.prepare("SELECT * FROM settings").all(),
          );
          assert.ok(!raw.includes(owner));
          assert.ok(!raw.includes(a.sync.pairInfo()!.deviceToken));
        },
      );
      await t.test(
        "without grants, heartbeat is independent of business activity and no event is uploaded",
        async () => {
          await a.sync.once();
          assert.equal(
            (
              await service.pool.query(
                "SELECT count(*)::int n FROM shared_events",
              )
            ).rows[0].n,
            0,
          );
          assert.ok(
            (
              await a.connect.own(
                "devices",
                "GET",
                undefined,
                a.sync.pairInfo()!.id,
              )
            ).devices.find((d: any) => d.id === a.sync.pairInfo()!.deviceId)
              .lastSeenAt,
          );
        },
      );
      const spec = {
        accountIds: ["a"],
        projectIds: [],
        shareQuota: true,
        from: new Date(Date.now() - 3600000).toISOString(),
        to: new Date(Date.now() + 86400000).toISOString(),
        retentionDays: 30,
      };
      const g = await a.sync.grant({
        ...spec,
        connectionId: a.sync.pairInfo()!.id,
      });
      await t.test(
        "offline quota persists, restarts and ACKs; another own device can read it",
        async () => {
          a.store.addQuota({
            id: "quota1",
            accountId: "a",
            sourceId: "s",
            pool: "codex",
            window: "300",
            observedAt: new Date().toISOString(),
            remainingPercent: 70,
            resetsAt: null,
            freshness: "fresh",
            identityEvidence: "confirmed",
          });
          await new Promise<void>((r) => server.close(() => r()));
          listening = false;
          await a.sync.once();
          assert.equal(
            (
              a.store.db
                .prepare("SELECT count(*) n FROM outbox WHERE acked=0")
                .get() as any
            ).n,
            1,
          );
          await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
          listening = true;
          const restarted = new SyncClient(a.store);
          await restarted.once();
          await restarted.once();
          assert.equal(
            (
              await service.pool.query(
                "SELECT count(*)::int n FROM shared_events",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (await b.connect.records(b.sync.pairInfo()!.id)).items.length,
            1,
          );
          restarted.stop();
        },
      );
      await t.test(
        "pause cancels local pending rows; withdrawal removes authorized data",
        async () => {
          a.sync.pause(g.id, true);
          a.store.addQuota({
            id: "quota2",
            accountId: "a",
            sourceId: "s",
            pool: "codex",
            window: "300",
            observedAt: new Date().toISOString(),
            remainingPercent: 60,
            resetsAt: null,
            freshness: "fresh",
            identityEvidence: "confirmed",
          });
          await a.sync.once();
          assert.equal(
            (await b.connect.records(b.sync.pairInfo()!.id)).items.length,
            1,
          );
          a.sync.pause(g.id, false);
          await a.sync.once();
          assert.equal(
            (await b.connect.records(b.sync.pairInfo()!.id)).items.length,
            2,
          );
          await a.sync.revoke(g.id);
          assert.equal(
            (await b.connect.records(b.sync.pairInfo()!.id)).items.length,
            0,
          );
        },
      );
      await t.test(
        "own device credential rotation and revocation invalidate the old credentials",
        async () => {
          const old = b.sync.pairInfo()!.deviceToken;
          await b.connect.rotate(b.sync.pairInfo()!.id);
          assert.equal(
            (
              await api("/v1/heartbeat", old, "POST", {
                collectorHealth: "healthy",
                taskState: "unknown",
              })
            ).status,
            401,
          );
          await a.connect.own(
            "devices/" + b.sync.pairInfo()!.deviceId,
            "DELETE",
            undefined,
            a.sync.pairInfo()!.id,
          );
          assert.equal(
            (
              await api(
                "/v1/heartbeat",
                b.sync.pairInfo()!.deviceToken,
                "POST",
                { collectorHealth: "healthy", taskState: "unknown" },
              )
            ).status,
            401,
          );
        },
      );
    } finally {
      a.sync.stop();
      b.sync.stop();
      for (const s of stores) s.close();
      if (listening) await new Promise<void>((r) => server.close(() => r()));
      await service.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
