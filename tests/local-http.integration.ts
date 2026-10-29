import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../core/store.js";
import { SyncClient } from "../collector/sync.js";
test(
  "真实本机HTTP：鉴权/Origin、私密正文不导出、备注、备份恢复和删除标记",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-http-"));
    const source = path.join(dir, "source");
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    const at = new Date().toISOString();
    const fixture = [
      {
        type: "session_meta",
        ordinal: 0,
        timestamp: at,
        payload: { id: "http-fixture", cwd: "C:\\private-project" },
      },
      {
        type: "event_msg",
        ordinal: 1,
        timestamp: at,
        payload: {
          type: "user_message",
          message: "Sensitive private prompt <script>alert(1)</script>",
        },
      },
      {
        type: "event_msg",
        ordinal: 2,
        timestamp: at,
        payload: { type: "task_started", turn_id: "t1" },
      },
    ];
    fs.writeFileSync(
      path.join(source, "sessions", "fixture.jsonl"),
      fixture.map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
    const socket = net.createServer();
    await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((r) => socket.close(() => r()));
    const key = "fixture-http-product-key";
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
          AIWM_LAUNCH_TOKEN: key,
        },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const base = "http://127.0.0.1:" + port;
    const headers = {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    };
    const request = async (p: string, method = "GET", body?: any) => {
      const r = await fetch(base + p, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    };
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const x = await request("/api/sessions");
          if (x.data.total === 1) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      assert.equal(ready, true);
      assert.equal((await fetch(base + "/api/overview")).status, 401);
      assert.equal(
        (
          await fetch(base + "/api/overview", {
            headers: { ...headers, Origin: "https://malicious.example" },
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(base + "/?launch=" + key, { redirect: "manual" })).status,
        302,
      );
      const exported = await request("/api/export");
      assert.equal(
        JSON.stringify(exported).includes("Sensitive private prompt"),
        false,
      );
      assert.equal(JSON.stringify(exported).includes("private-project"), false);
      assert.equal((await request("/api/settings")).data.hooksEnabled, false);
      await request("/api/settings", "POST", { hooksEnabled: true });
      assert.equal((await request("/api/settings")).data.hooks.enabled, true);
      assert.equal(
        (await request("/api/settings")).data.hooks.status,
        "awaiting_event",
      );
      const hookFile = path.join(source, "hooks.json");
      assert.equal(
        JSON.parse(fs.readFileSync(hookFile, "utf8")).hooks.Stop[0].hooks[0]
          .type,
        "command",
      );
      await request("/api/settings", "POST", { hooksEnabled: false });
      assert.deepEqual(JSON.parse(fs.readFileSync(hookFile, "utf8")).hooks, {});
      assert.equal((await request("/api/settings")).data.hooks.status, "off");
      fs.writeFileSync(hookFile, "invalid-user-config");
      assert.equal(
        (await request("/api/settings", "POST", { hooksEnabled: true })).status,
        400,
      );
      assert.equal((await request("/api/settings")).data.hooksEnabled, false);
      assert.equal(fs.readFileSync(hookFile, "utf8"), "invalid-user-config");
      await request("/api/sessions/http-fixture/note", "POST", {
        notes: "fixture note",
        pinned: true,
      });
      assert.equal(
        (await request("/api/sessions/http-fixture")).data.notes,
        "fixture note",
      );
      const saved = await request("/api/backup", "POST", {});
      assert.equal(saved.status, 200);
      await request("/api/sessions/http-fixture", "DELETE");
      assert.equal((await request("/api/sessions/http-fixture")).status, 404);
      const restored = await request("/api/restore", "POST", {
        file: saved.data.file,
      });
      assert.equal(restored.status, 200, JSON.stringify(restored));
      await delay(300);
      assert.equal((await request("/api/sessions/http-fixture")).status, 404);
      assert.equal(
        (await request("/api/restore", "POST", { file: "../../source/file" }))
          .status,
        400,
      );
      assert.equal(
        fs.readFileSync(path.join(source, "sessions", "fixture.jsonl"), "utf8"),
        fixture.map((x) => JSON.stringify(x)).join("\n") + "\n",
      );
    } finally {
      child.kill();
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r();
        else {
          child.once("exit", () => r());
          setTimeout(r, 3000).unref();
        }
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

for (const scenario of [
  { name: "older selection revision", savedRevision: 2, inFlight: false },
  { name: "newer selection revision", savedRevision: 40, inFlight: false },
  { name: "registration already in flight", savedRevision: 2, inFlight: true },
])
  test(
    `HTTP restore preserves selection monotonicity and clears connections: ${scenario.name}`,
    { timeout: 30000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-restore-drain-"));
      const source = path.join(dir, "source"),
        monitor = path.join(dir, "monitor");
      fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const remote = http.createServer(async (req, res) => {
        if (req.url !== "/v1/self/register") {
          res.writeHead(404);
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        entered();
        await gate;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            protocolVersion: 1,
            deviceId: "new-device",
            deviceToken: body.registrationToken,
            userId: "fixture-owner",
            workspaceId: "A",
            kind: "company",
          }),
        );
      });
      await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
      const remoteUrl = `http://127.0.0.1:${(remote.address() as net.AddressInfo).port}`;
      const initial = new Store(monitor),
        initialSync = new SyncClient(initial);
      initial.setSetting("sourceConfigs", []);
      initial.setSetting("deviceId", "fixture-physical-device");
      initial.setSetting("environmentId", "fixture-environment");
      initialSync.addConnection({
        url: remoteUrl,
        protocolVersion: 1,
        deviceId: "old-device",
        deviceToken: "fixture-old-token",
        userId: "fixture-owner",
        workspaceId: "A",
      });
      initial.setSetting("activeHubSelectionRevision", scenario.savedRevision);
      const saved = await initial.backup();
      initial.setSetting("activeHubSelectionRevision", 7);
      if (scenario.inFlight)
        initial.setSetting("pendingRegistrations", {
          pending: {
            id: "pending",
            stage: "registering",
            url: remoteUrl,
            credential: "fixture-recovery",
            userId: "fixture-owner",
            workspaceId: "A",
            name: "A",
            registrationId: "fixture-registration",
            registrationToken: "fixture-device-proof",
            createdAt: new Date().toISOString(),
          },
        });
      initial.close();
      const socket = net.createServer();
      await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
      const port = (socket.address() as net.AddressInfo).port;
      await new Promise<void>((r) => socket.close(() => r()));
      const key = "fixture-restore-token";
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "server/index.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AIWM_DATA_DIR: monitor,
            CODEX_HOME: source,
            AIWM_QUOTA_DISABLED: "1",
            AIWM_PORT: String(port),
            AIWM_LAUNCH_TOKEN: key,
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const request = async (route: string, method = "GET", body?: any) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      };
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            ready = (await request("/api/sharing")).status === 200;
            if (ready) break;
          } catch {}
          await delay(50);
        }
        assert.equal(ready, true);
        let registration: Promise<any> | undefined;
        if (scenario.inFlight) {
          registration = request("/api/connections/resume", "POST", {
            pendingId: "pending",
          });
          await Promise.race([
            reached,
            registration.then((result) => {
              throw Error(
                `registration did not reach held service: ${JSON.stringify(result)}`,
              );
            }),
          ]);
        }
        const restore = request("/api/restore", "POST", { file: saved });
        const finishedBeforeRelease = scenario.inFlight
          ? await Promise.race([
              restore.then(() => true),
              delay(150).then(() => false),
            ])
          : false;
        if (scenario.inFlight) {
          assert.equal(
            (await request("/api/sharing")).status,
            503,
            "new reads are gated during restore",
          );
          assert.equal(
            (
              await request("/api/connections/resume", "POST", {
                pendingId: "pending",
              })
            ).status,
            503,
            "new writes cannot extend the maintenance drain",
          );
        }
        release();
        if (registration) {
          const result = await registration;
          assert.equal(result.data.ok, true, JSON.stringify(result));
        }
        const result = await restore;
        assert.equal(result.status, 200, JSON.stringify(result));
        const sharing = await request("/api/sharing");
        const after = await request("/api/backup", "POST", {});
        assert.equal(after.status, 200, JSON.stringify(after));
        const snapshot = new DatabaseSync(
          path.join(monitor, "backups", after.data.file),
          { readOnly: true },
        );
        let revision: number;
        try {
          revision = JSON.parse(
            (
              snapshot
                .prepare(
                  "SELECT value FROM settings WHERE key='activeHubSelectionRevision'",
                )
                .get() as any
            ).value,
          );
        } finally {
          snapshot.close();
        }
        assert.deepEqual(
          {
            finishedBeforeRelease,
            connections: sharing.data.connections.length,
            pair: sharing.data.pair,
            revision,
          },
          {
            finishedBeforeRelease: false,
            connections: 0,
            pair: null,
            revision:
              Math.max(scenario.savedRevision, scenario.inFlight ? 8 : 7) + 1,
          },
          "restore must drain earlier writers, clear every connection, and advance the greater selection revision",
        );
        assert.deepEqual(
          (await request("/api/connections/pending")).data.items,
          [],
        );
      } finally {
        release();
        child.kill();
        if (child.exitCode === null)
          await new Promise<void>((r) => child.once("exit", () => r()));
        await new Promise<void>((r) => remote.close(() => r()));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
