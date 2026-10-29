import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../core/store.js";
import type { Event } from "../core/model.js";

const digest = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function event(id: string, sessionId: string, metadata = false): Event {
  const at = "2026-10-01T00:00:00.000Z";
  return {
    id,
    sessionId,
    turnId: "fixture-turn",
    agentId: sessionId,
    upstreamId: metadata ? null : id,
    provider: "codex",
    deviceId: "fixture-event-device",
    environmentId: "fixture-event-env",
    sourceId: "fixture-source",
    projectId: "fixture-project",
    accountId: null,
    kind: metadata ? "session_meta" : "usage_response",
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    sequence: 1,
    schemaVersion: 2,
    evidence: "confirmed",
    data: metadata
      ? { title: sessionId, metadataOnly: true, sourceKind: "database" }
      : { usage: { input: 100, output: 20 } },
  };
}

test(
  "真实本机 HTTP：历史补回鉴权、来源和账号冲突中文提示、安全诊断、只读预览、预览后新增保留、备份及幂等重试",
  { timeout: 90000 },
  async () => {
    // All stores and Codex-shaped source files are isolated fixtures. The running
    // server receives no real source directory and no production credentials.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-http-"));
    const dataDir = path.join(dir, "monitor"),
      source = path.join(dir, "source"),
      legacyDir = path.join(dir, "legacy");
    fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
    const current = new Store(dataDir);
    current.setSetting("indexParserVersion", 4);
    current.setSetting("sourceConfigs", []);
    current.setSetting("deviceId", "http-current-device");
    current.setSetting("environmentId", "http-current-environment");
    current.setSetting("preferences", {
      hooksEnabled: false,
      notifications: { enabled: false },
    });
    current.insert(event("current-metadata", "historical", true));
    current.insert(event("current-only", "current-session"));
    current.projectDirty();
    const conflictSource = {
      id: "conflict-source",
      label: "Current source fixture",
      kind: "manual",
      environmentId: "current-fixture-environment",
      pathLabel: "fixture-path",
      health: "healthy",
      lastScanAt: "2026-10-01T00:00:00Z",
      errorCount: 0,
      capabilities: {},
    };
    current.source(conflictSource);
    for (const account of ["account-a", "account-b"])
      current.db
        .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
        .run(account, account, "codex", "manual");
    current.db
      .prepare("INSERT INTO bindings VALUES(?,?,?,?,?,?,0)")
      .run(
        "current-http-binding",
        "account-a",
        "fixture-source",
        "2026-09-01T00:00:00.000Z",
        "2026-11-01T00:00:00.000Z",
        "manual",
      );
    current.close();
    const legacy = new Store(legacyDir);
    legacy.setSetting("deviceId", "old-device-must-not-replace-current");
    const legacyHeader = event("legacy-header", "historical", true);
    legacyHeader.data = { title: "Historical fixture", sourceKind: "log" };
    legacy.insert(legacyHeader);
    legacy.insert(event("legacy-only", "historical"));
    const legacySource = {
      id: "historical-source",
      label: "Legacy historical source",
      kind: "manual",
      environmentId: "legacy-environment",
      pathLabel: "legacy",
      health: "healthy",
      lastScanAt: "2026-01-01T00:00:00Z",
      errorCount: 0,
      capabilities: {},
    };
    legacy.source(legacySource);
    legacy.projectDirty();
    const file = "monitor-1000.sqlite",
      backupDir = path.join(dataDir, "backups"),
      legacyFile = path.join(backupDir, file);
    fs.mkdirSync(backupDir);
    await backup(legacy.db, legacyFile);
    legacy.close();
    const legacyHash = digest(legacyFile);
    // These conflicting backups are independently generated fixtures. The test
    // reaches the real server route, core rejection, user message and support
    // diagnostics without replacing or patching any production implementation.
    const sourceConflict = new Store(path.join(dir, "source-conflict"));
    sourceConflict.source({
      ...conflictSource,
      environmentId: "PRIVATE_ENVIRONMENT_DO_NOT_EXPOSE",
    });
    const sourceConflictName = "monitor-2000.sqlite";
    await backup(sourceConflict.db, path.join(backupDir, sourceConflictName));
    sourceConflict.close();
    const bindingConflict = new Store(path.join(dir, "binding-conflict"));
    for (const account of ["account-a", "account-b"])
      bindingConflict.db
        .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
        .run(account, account, "codex", "manual");
    bindingConflict.db
      .prepare("INSERT INTO bindings VALUES(?,?,?,?,?,?,0)")
      .run(
        "PRIVATE_CONFLICT_BINDING_DO_NOT_EXPOSE",
        "account-b",
        "fixture-source",
        "2026-09-15T00:00:00.000Z",
        "2026-10-15T00:00:00.000Z",
        "manual",
      );
    const bindingConflictName = "monitor-3000.sqlite";
    await backup(bindingConflict.db, path.join(backupDir, bindingConflictName));
    bindingConflict.close();
    const conflictHashes = [sourceConflictName, bindingConflictName].map(
      (name) => digest(path.join(backupDir, name)),
    );
    const listener = net.createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const token = "fixture-history-http-key",
      base = `http://127.0.0.1:${port}`;
    const fixtureKey = randomBytes(32).toString("base64");
    let log = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    child.on("message", (message: any) => {
      if (message?.type === "credential-key-request")
        child.send({ type: "credential-key", key: fixtureKey });
    });
    child.stdout!.on("data", (b) => {
      log = (log + b.toString()).slice(-12000);
    });
    child.stderr!.on("data", (b) => {
      log = (log + b.toString()).slice(-12000);
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const request = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(base + route, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    const ok = async (route: string, method = "GET", body?: unknown) => {
      const result = await request(route, method, body);
      assert.equal(
        result.status,
        200,
        `${route}: ${JSON.stringify(result.data)}`,
      );
      return result.data;
    };
    try {
      let ready = false,
        readiness = "no response";
      for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null)
          throw Error(`fixture server exited: ${log}`);
        try {
          const response = await request("/api/sessions");
          readiness = `${response.status}: ${response.data.total ?? "no session count"}`;
          if (response.status === 200 && response.data.total === 2) {
            ready = true;
            break;
          }
        } catch (error: any) {
          readiness = `${error?.message ?? error}: ${error?.cause?.code ?? ""}`;
        }
        await delay(100);
      }
      assert.equal(
        ready,
        true,
        `isolated server readiness: ${readiness}\n${log}`,
      );
      const route = "/api/history-recovery/preview";
      const beforeConflicts = await ok("/api/overview");
      for (const fixture of [
        {
          file: sourceConflictName,
          code: "history-recovery-source-identity-conflict",
          message: /来源身份.*不一致/,
        },
        {
          file: bindingConflictName,
          code: "history-recovery-binding-overlap-conflict",
          message: /账号关联时间重叠.*不同账号/,
        },
      ]) {
        const rejected = await request(route, "POST", { file: fixture.file });
        assert.equal(rejected.status, 400);
        assert.match(rejected.data.error, fixture.message);
        assert.match(rejected.data.error, /核对|联系支持/);
        assert.doesNotMatch(
          rejected.data.error,
          /history-recovery-|PRIVATE_|[A-Za-z]:[\\/]/,
        );
        const diagnostic = (await ok("/api/diagnostics")).historyRecovery;
        assert.deepEqual(Object.keys(diagnostic).sort(), [
          "at",
          "code",
          "id",
          "phase",
        ]);
        assert.equal(diagnostic.code, fixture.code);
        assert.equal(diagnostic.phase, "preview");
        assert.ok(Number.isFinite(Date.parse(diagnostic.at)));
        const serialized = JSON.stringify(diagnostic);
        assert.doesNotMatch(
          serialized,
          /PRIVATE_|fixture-source|conflict-source|\.sqlite|[A-Za-z]:[\\/]/,
        );
        assert.ok(!serialized.includes(dir));
        assert.equal(
          (await ok("/api/overview")).events,
          beforeConflicts.events,
        );
        assert.equal(
          (await ok("/api/sessions/current-session")).session.accountId,
          "account-a",
        );
      }
      assert.deepEqual(
        [sourceConflictName, bindingConflictName].map((name) =>
          digest(path.join(backupDir, name)),
        ),
        conflictHashes,
      );
      assert.equal(
        (
          await fetch(base + route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file }),
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(base + route, {
            method: "POST",
            headers: { ...headers, Origin: "https://malicious.example" },
            body: JSON.stringify({ file }),
          })
        ).status,
        403,
      );
      assert.equal(
        (await request(route, "POST", { file: "../monitor.sqlite" })).status,
        400,
      );
      assert.equal(
        (
          await request("/api/history-recovery/apply", "POST", {
            file,
            token: "not-issued",
          })
        ).status,
        400,
      );
      await ok("/api/sessions/historical/note", "POST", {
        notes: "preserve current note",
        pinned: true,
      });
      const before = await ok("/api/overview"),
        beforeIdentity = await ok("/api/accounts");
      const preview = await ok(route, "POST", { file });
      assert.equal(preview.file, file);
      assert.equal(typeof preview.token, "string");
      assert.equal(preview.counts.eventsAdded, 2);
      assert.equal(preview.counts.sessionsRecovered, 1);
      const afterPreview = await ok("/api/overview");
      assert.equal(
        afterPreview.events,
        before.events,
        "preview must not import history",
      );
      assert.equal(afterPreview.sessions, before.sessions);
      assert.equal(
        (await ok("/api/sessions/historical")).session.metadataOnly,
        true,
      );
      assert.equal(digest(legacyFile), legacyHash);

      // New work arrives through the actual collector/API after preview, not a
      // test-side write to the live Monitor SQLite file.
      const at = new Date().toISOString(),
        sourceFile = path.join(source, "sessions", "arrival.jsonl");
      const arrival =
        [
          {
            type: "session_meta",
            timestamp: at,
            payload: {
              id: "arrived-after-preview",
              cwd: "C:\\fixture-only-project",
            },
          },
          {
            type: "event_msg",
            timestamp: at,
            payload: { type: "task_started", turn_id: "arrival-turn" },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n";
      fs.writeFileSync(sourceFile, arrival);
      const sourceResult = await request("/api/sources", "POST", {
        path: source,
        label: "fixture-only source",
        kind: "manual",
      });
      assert.equal(sourceResult.status, 201);
      let arrived = false;
      for (let i = 0; i < 100; i++) {
        if (
          (await request("/api/sessions/arrived-after-preview")).status === 200
        ) {
          arrived = true;
          break;
        }
        await delay(50);
      }
      assert.equal(
        arrived,
        true,
        "collector must ingest the new fixture before apply",
      );
      await ok("/api/sessions/current-session/note", "POST", {
        notes: "written after preview",
        pinned: true,
      });
      const beforeApply = await ok("/api/overview");
      const applied = await ok("/api/history-recovery/apply", "POST", {
        file,
        token: preview.token,
      });
      assert.equal(applied.counts.eventsAdded, 2);
      assert.equal(applied.counts.sessionsRecovered, 1);
      assert.match(applied.backup, /^monitor-\d+\.sqlite$/);
      assert.notEqual(applied.backup, file);
      const restored = await ok("/api/sessions/historical");
      assert.equal(restored.session.metadataOnly, false);
      assert.equal(restored.session.totalTokens, 120);
      assert.equal(restored.notes, "preserve current note");
      assert.equal(restored.session.pinned, true);
      assert.ok(restored.events.some((e: any) => e.id === "legacy-only"));
      assert.equal(
        (await ok("/api/sessions/current-session")).notes,
        "written after preview",
      );
      assert.equal(
        (await ok("/api/sessions/arrived-after-preview")).session.id,
        "arrived-after-preview",
      );
      const afterApply = await ok("/api/overview"),
        afterIdentity = await ok("/api/accounts");
      assert.equal(afterApply.events, beforeApply.events + 2);
      assert.equal(afterApply.sessions, beforeApply.sessions);
      const repairedSources = (await ok("/api/sources")).sources;
      assert.equal(
        repairedSources.find((s: any) => s.id === legacySource.id)
          ?.collectionEnabled,
        false,
        "imported source evidence is historical, not an enabled collector",
      );
      assert.equal(
        repairedSources.find((s: any) => s.id === sourceResult.data.id)
          ?.collectionEnabled,
        true,
      );
      assert.equal(
        afterApply.sources.find((s: any) => s.id === legacySource.id)
          ?.collectionEnabled,
        false,
        "overview must use the same collection scope",
      );
      await ok(`/api/sources/${legacySource.id}`, "DELETE");
      assert.ok(
        (await ok("/api/sources")).sources.some(
          (s: any) => s.id === legacySource.id,
        ),
        "stop must not delete historical source evidence",
      );
      assert.deepEqual(afterIdentity.devices, beforeIdentity.devices);
      assert.deepEqual(afterIdentity.environments, beforeIdentity.environments);
      assert.equal((await ok("/api/settings")).hooksEnabled, false);
      const saved = new DatabaseSync(path.join(backupDir, applied.backup), {
        readOnly: true,
      });
      try {
        assert.equal(
          saved
            .prepare("SELECT count(*) n FROM events WHERE id='legacy-only'")
            .get()?.n,
          0,
        );
        assert.ok(
          Number(
            saved
              .prepare(
                "SELECT count(*) n FROM events WHERE session_id='arrived-after-preview'",
              )
              .get()?.n,
          ) > 0,
        );
        assert.equal(
          saved
            .prepare("SELECT notes FROM sessions WHERE id='current-session'")
            .get()?.notes,
          "written after preview",
        );
        assert.equal(
          saved.prepare("PRAGMA integrity_check").get()?.integrity_check,
          "ok",
        );
      } finally {
        saved.close();
      }
      assert.equal(
        (
          await request("/api/history-recovery/apply", "POST", {
            file,
            token: preview.token,
          })
        ).status,
        400,
        "consumed token must reject",
      );
      const repeatedPreview = await ok(route, "POST", { file });
      assert.equal(repeatedPreview.counts.eventsAdded, 0);
      const repeated = await ok("/api/history-recovery/apply", "POST", {
        file,
        token: repeatedPreview.token,
      });
      assert.equal(repeated.idempotent, true);
      assert.equal(repeated.counts.eventsAdded, 0);
      assert.equal((await ok("/api/overview")).events, afterApply.events);
      assert.equal(
        digest(legacyFile),
        legacyHash,
        "legacy backup remains byte identical",
      );
      assert.equal(
        fs.readFileSync(sourceFile, "utf8"),
        arrival,
        "collector leaves source fixture unchanged",
      );
      await ok(`/api/sources/${sourceResult.data.id}`, "DELETE");
      const stoppedSource = (await ok("/api/sources")).sources.find(
        (s: any) => s.id === sourceResult.data.id,
      );
      assert.ok(
        stoppedSource,
        "stopping current collection retains the source's historical evidence",
      );
      assert.equal(stoppedSource.collectionEnabled, false);
      const stoppedOverview = await ok("/api/overview");
      assert.equal(stoppedOverview.events, afterApply.events);
    } finally {
      if (child.connected) child.send({ type: "shutdown" });
      const exited = await new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        child.kill();
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
      assert.equal(
        exited,
        true,
        "fixture should stop through normal IPC shutdown",
      );
      assert.equal(child.exitCode, 0, log);
      assert.doesNotMatch(
        log,
        /database is not open|database is closed|SQLITE_MISUSE/i,
      );
      const absolute = path.resolve(dir),
        temp = path.resolve(os.tmpdir());
      assert.equal(path.dirname(absolute), temp);
      assert.ok(path.basename(absolute).startsWith("hr-http-"));
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  },
);
