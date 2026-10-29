import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../core/store.js";
import type { Event } from "../core/model.js";

const timestamp = "2026-10-26T01:00:00.000Z";
function event(id: string): Event {
  return {
    id: `event-${id}`,
    sessionId: id,
    turnId: null,
    agentId: id,
    upstreamId: null,
    provider: "codex",
    deviceId: "fixture-device",
    environmentId: "fixture-environment",
    sourceId: "fixture-source",
    projectId: "fixture-project",
    accountId: null,
    kind: "session_meta",
    occurredAt: timestamp,
    observedAt: timestamp,
    receivedAt: timestamp,
    sequence: 0,
    schemaVersion: 2,
    evidence: "confirmed",
    data: {
      title: "private task title",
      projectPath: "C:\\private-project",
      text: "private transcript",
    },
  };
}
type Batch = {
  items: { sessionId: string }[];
  count: number;
  nextCursor: string | null;
  snapshotAt: string;
  snapshotCount: number;
  metadataOnly: boolean;
};

test(
  "真实本机HTTP：1005条同时间会话完整导出、冻结新增边界、删除即时过滤和实际条数",
  { timeout: 90000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-export-http-"));
    const dataDir = path.join(dir, "monitor"),
      source = path.join(dir, "codex-fixture");
    fs.mkdirSync(source);
    const initialIds = Array.from(
      { length: 1005 },
      (_, i) => `export-${String(i).padStart(4, "0")}`,
    );
    const store = new Store(dataDir);
    try {
      store.setSetting("indexParserVersion", 4);
      store.setSetting("sourceConfigs", []);
      store.setSetting("deviceId", "fixture-device");
      store.setSetting("environmentId", "fixture-environment");
      store.transaction(() => {
        for (const id of initialIds) store.insert(event(id));
      });
      store.projectDirty();
    } finally {
      store.close();
    }
    const socket = net.createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
    );
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const token = "fixture-export-http-key",
      base = `http://127.0.0.1:${port}`;
    let log = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AIWM_DATA_DIR: dataDir,
          CODEX_HOME: source,
          AIWM_QUOTA_DISABLED: "1",
          AIWM_PORT: String(port),
          AIWM_LAUNCH_TOKEN: token,
        },
      },
    );
    child.stdout.on("data", (b) => {
      log = (log + b.toString()).slice(-12000);
    });
    child.stderr.on("data", (b) => {
      log = (log + b.toString()).slice(-12000);
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const request = async (route: string, method = "GET") => {
      const response = await fetch(base + route, { method, headers });
      const data = await response.json();
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`);
      return data;
    };
    const page = async (cursor?: string | null): Promise<Batch> => {
      const batch = (await request(
        "/api/export" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
      )) as Batch;
      assert.equal(batch.count, batch.items.length);
      assert.equal(batch.metadataOnly, true);
      assert.ok(
        batch.items.length <= 200,
        "traversal must retain a bounded page size",
      );
      const serialized = JSON.stringify(batch);
      for (const secret of [
        "private task title",
        "private-project",
        "private transcript",
      ])
        assert.equal(serialized.includes(secret), false);
      return batch;
    };
    const finish = async (first: Batch) => {
      const ids: string[] = [],
        counts: number[] = [];
      let batch = first,
        pages = 0;
      for (;;) {
        assert.equal(batch.snapshotAt, first.snapshotAt);
        assert.equal(batch.snapshotCount, first.snapshotCount);
        ids.push(...batch.items.map((item) => item.sessionId));
        counts.push(batch.count);
        assert.ok(++pages < 20, "cursor traversal must terminate");
        if (!batch.nextCursor) break;
        batch = await page(batch.nextCursor);
      }
      assert.equal(
        new Set(ids).size,
        ids.length,
        "no duplicate rows across same-timestamp page boundaries",
      );
      assert.equal(
        counts.reduce((sum, count) => sum + count, 0),
        ids.length,
      );
      return { ids, pages };
    };
    try {
      let ready = false,
        readiness = "no response";
      for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null)
          throw new Error(`fixture server exited: ${log}`);
        try {
          const response = await fetch(base + "/api/sessions", { headers });
          const body = await response.text();
          readiness = `${response.status}: ${body.slice(0, 500)}`;
          if (
            response.ok &&
            (JSON.parse(body) as { total: number }).total === 1005
          ) {
            ready = true;
            break;
          }
        } catch (error) {
          readiness = String(error);
        }
        await delay(100);
      }
      assert.equal(
        ready,
        true,
        `isolated server readiness: ${readiness}\n${log}`,
      );
      assert.equal((await fetch(base + "/api/export")).status, 401);
      assert.equal(
        (
          await fetch(base + "/api/export", {
            headers: { ...headers, Origin: "https://malicious.example" },
          })
        ).status,
        403,
      );
      const initial = await finish(await page());
      assert.equal(initial.pages, 6);
      assert.deepEqual(new Set(initial.ids), new Set(initialIds));

      const frozen = await page();
      assert.equal(frozen.snapshotCount, 1005);
      const served = new Set(frozen.items.map((item) => item.sessionId));
      const removed = initialIds.find((id) => !served.has(id))!;
      const added = "export-added-after-snapshot";
      // Mutation belongs only to this test's temporary Monitor database. The live
      // server's next request observes it, while the export membership stays frozen.
      const writer = new Store(dataDir);
      try {
        writer.insert(event(added));
        writer.projectDirty();
      } finally {
        writer.close();
      }
      await request(`/api/sessions/${removed}`, "DELETE");
      const during = await finish(frozen);
      assert.equal(during.ids.length, 1004);
      assert.equal(during.ids.includes(added), false);
      assert.equal(during.ids.includes(removed), false);
      assert.deepEqual(
        new Set(during.ids),
        new Set(initialIds.filter((id) => id !== removed)),
      );

      const fresh = await finish(await page());
      assert.equal(fresh.ids.length, 1005);
      assert.ok(fresh.ids.includes(added));
      assert.equal(fresh.ids.includes(removed), false);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else {
          child.once("exit", () => resolve());
          setTimeout(resolve, 3000).unref();
        }
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
