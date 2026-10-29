import { Connections } from "../collector/connections.js";
import { appVersion } from "../core/version.js";
import { QuotaScheduler } from "../collector/quota-scheduler.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "../core/store.js";
import { receiveDesktopKey } from "../core/credentials.js";
import { ExportSnapshots } from "../core/pagination.js";
import { Collector } from "../collector/collector.js";
import { SyncClient } from "../collector/sync.js";
import { configureHooks, hookGate } from "../collector/hook-install.js";
import { hookPreview, migrateHookSwitch } from "../collector/hooks.js";
import { readDatabaseHistory } from "../collector/database-history.js";
import { execFile } from "node:child_process";
import { HistoryRecovery } from "./history-recovery.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes("/dist/") ? "../.." : "..",
);
const dataDir = path.resolve(
  process.env.AIWM_DATA_DIR ?? path.join(root, ".data"),
);
// Preserve committed WAL data and Monitor configuration before any schema change.
const existingFile = path.join(dataDir, "monitor.sqlite");
if (fs.existsSync(existingFile)) {
  const old = new DatabaseSync(existingFile, { readOnly: true });
  try {
    if (
      Number((old.prepare("PRAGMA user_version").get() as any).user_version) < 3
    ) {
      const saved = path.join(dataDir, "backups", `pre-0.2.0-${Date.now()}`);
      fs.mkdirSync(saved, { recursive: true });
      await backup(old, path.join(saved, "monitor.sqlite"));
      for (const name of fs
        .readdirSync(dataDir)
        .filter((n) => n.endsWith(".json")))
        if (fs.statSync(path.join(dataDir, name)).isFile())
          fs.copyFileSync(path.join(dataDir, name), path.join(saved, name));
    }
  } finally {
    old.close();
  }
}
await receiveDesktopKey();
const store = new Store(dataDir);
migrateHookSwitch(store);
const port = Number(process.env.AIWM_PORT ?? 4318);
const launchToken =
  process.env.AIWM_LAUNCH_TOKEN ?? randomBytes(32).toString("base64url");
if (store.getSetting("indexParserVersion", 0) < 4) {
  if ((store.db.prepare("SELECT count(*) n FROM events").get() as any).n)
    store.setSetting("legacyParserNeedsReview", true);
  store.setSetting("indexParserVersion", 4);
}
await store.recomputeDerived({ backup: true });
const viewers = new Set<http.ServerResponse>();
let revision = 0;
let maintenance = false;
const activeApi = new Set<http.ServerResponse>();
const manualScans = new Set<Promise<unknown>>();
function trackScan(operation: Promise<unknown>) {
  manualScans.add(operation);
  void operation.catch(() => {}).finally(() => manualScans.delete(operation));
}
const collector = new Collector(store, () => {
  revision++;
  for (const r of viewers)
    r.write(
      "data: " + JSON.stringify({ revision, scan: collector.scan }) + "\n\n",
    );
});
function collectionSources() {
  const configs = collector.configs();
  const active = new Set(configs.map((source) => source.id));
  const sources = store.sources();
  const observed = new Set(sources.map((source) => source.id));
  // Source rows are historical evidence, not the configured collection scope.
  // A configured source with no observation must still surface as unknown.
  return [
    ...sources.map((source) => ({
      ...source,
      collectionEnabled: active.has(source.id),
    })),
    ...configs
      .filter((source) => !observed.has(source.id))
      .map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
        environmentId: source.environmentId,
        pathLabel: path.basename(source.path),
        health: "unknown",
        lastScanAt: null,
        errorCount: 0,
        capabilities: {},
        collectionEnabled: true,
      })),
  ];
}
const sync = new SyncClient(store);
const connections = new Connections(store, sync);
const quotaScheduler = new QuotaScheduler(store, () => {
  revision++;
  void sync.once();
});
async function pauseMonitorWrites() {
  maintenance = true;
  quotaScheduler.stop();
  collector.stop();
  sync.stop();
  const { refreshQuota } = await import("../collector/quota.js");
  await refreshQuota.cancel(store);
  // The maintenance request itself remains active. Drain requests which passed
  // the maintenance gate earlier, along with background writers, before backup.
  while (activeApi.size > 1 || manualScans.size || sync.running || collector.scan.phase === "scanning")
    await new Promise((resolve) => setTimeout(resolve, 20));
  store.projectDirty();
}
function resumeMonitorWrites() {
  maintenance = false;
  revision++;
  if (!shuttingDown) {
    collector.start();
    sync.start();
    if (process.env.AIWM_QUOTA_DISABLED !== "1") quotaScheduler.start();
  }
}
const historyRecovery = new HistoryRecovery(store, {
  pause: pauseMonitorWrites,
  resume: resumeMonitorWrites,
});
let diagnosing = false;
function runDiagnostics() {
  if (diagnosing) return;
  diagnosing = true;
  const compiled = path.join(root, "dist", "scripts", "diagnose.js");
  const args = fs.existsSync(compiled)
    ? [compiled]
    : ["--import", "tsx", path.join(root, "scripts", "diagnose.ts")];
  execFile(
    process.execPath,
    [...args, "--out", path.join(dataDir, "diagnostics.json")],
    {
      cwd: root,
      env: { ...process.env, AIWM_DATA_DIR: dataDir },
      windowsHide: true,
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    },
    () => {
      diagnosing = false;
    },
  );
}
const defaults = {
  hooksEnabled: false,
  pollMs: 1500,
  staleMs: 15000,
  notifications: {
    enabled: false,
    quietStart: 22,
    quietEnd: 8,
    quotaThreshold: 15,
  },
  retentionDays: 0,
};
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(res: http.ServerResponse, status: number, value: any) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const b of req) {
    size += b.length;
    if (size > 1024 * 1024) throw Error("请求超过 1 MiB");
    chunks.push(b);
  }
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}
const settings = () => ({
  ...defaults,
  ...store.getSetting("preferences", {}),
  hubUrl: sync.pairInfo()?.url ?? "",
  hubStatus: sync.status,
  hooks: hookPreview(
    dataDir,
    store.getSetting<any>("preferences", {}).hooksEnabled === true,
    store.getSetting<string | undefined>("lastHookObservedAt", undefined),
  ),
  hookCleanupError: store.getSetting("hookCleanupError", null),
  hookPendingCount: store.getSetting("hookPendingCount", 0),
  hookRejectedCount: store.getSetting("hookRejectedCount", 0),
  hookQueueError: store.getSetting("hookQueueError", null),
  diskBytes: store.diskBytes(),
  backups: fs.existsSync(path.join(dataDir, "backups"))
    ? fs
        .readdirSync(path.join(dataDir, "backups"))
        .filter((x) => /^monitor-\d+\.sqlite$/.test(x))
    : [],
});
const localExports = new ExportSnapshots<
  ReturnType<typeof safeSessions>[number]
>();
function safeSessions(params: URLSearchParams) {
  const p = new URLSearchParams(params);
  p.set("pageSize", "200");
  return store.sessions(p).items.map((s) => ({
    sessionId: s.id,
    sourceId: s.sourceId,
    accountId: s.accountId,
    model: s.model,
    state: s.state,
    evidence: s.evidence,
    freshness: s.freshness,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    totalTokens: s.totalTokens,
  }));
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  if (
    !["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(
      req.socket.remoteAddress ?? "",
    )
  ) {
    json(res, 403, { error: "只允许本机调用" });
    return;
  }
  if (
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")
  ) {
    json(res, 403, { error: "Host 不受信" });
    return;
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const p = url.pathname;
  const origin = req.headers.origin;
  if (
    origin &&
    ![
      "http://127.0.0.1:" + port,
      "http://localhost:" + port,
      ...(process.env.NODE_ENV === "development"
        ? ["http://127.0.0.1:5173", "http://localhost:5173"]
        : []),
    ].includes(origin)
  ) {
    json(res, 403, { error: "Origin 不受信" });
    return;
  }
  if (url.searchParams.has("launch")) {
    if (!equal(url.searchParams.get("launch") ?? "", launchToken)) {
      json(res, 401, { error: "无效启动凭据" });
      return;
    }
    res.writeHead(302, {
      "Set-Cookie": `aiwm=${launchToken}; HttpOnly; SameSite=Strict; Path=/`,
      Location: "/",
    });
    res.end();
    return;
  }
  const cookie =
    (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("aiwm="))
      ?.slice(5) ?? "";
  const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (
    p.startsWith("/api/") &&
    !equal(cookie, launchToken) &&
    !equal(bearer, launchToken)
  ) {
    json(res, 401, { error: "请通过本产品启动链接打开，以建立本机访问权限" });
    return;
  }
  if ((maintenance || shuttingDown) && p.startsWith("/api/")) {
    json(res, 503, { error: shuttingDown ? "监控服务正在退出" : "正在维护本机监控数据，请稍后" });
    return;
  }
  if (p.startsWith("/api/") && p !== "/api/events") activeApi.add(res);
  let ownsMaintenance = false;
  try {
    if (p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(
        "data: " + JSON.stringify({ revision, scan: collector.scan }) + "\n\n",
      );
      viewers.add(res);
      req.on("close", () => viewers.delete(res));
      return;
    }
    if (req.method === "GET") {
      if (p === "/api/quota/sources") {
        const current = store.db
          .prepare(
            "SELECT value FROM settings WHERE key LIKE 'quotaIdentity:%'",
          )
          .all() as any[];
        json(res, 200, {
          sources: current.map((r) => {
            const v = JSON.parse(r.value);
            const q = store.quotas().find((q) => q.sourceId === v.sourceId);
            return {
              id: v.sourceId,
              label: "当前 Codex 额度来源",
              confirmed: v.confirmed,
              observedAt: q?.observedAt,
              accountId: q?.accountId,
              manual: (q as any)?.identityEvidence === "manual",
            };
          }),
        });
        return;
      }
      if (p === "/api/connections/devices") {
        json(
          res,
          200,
          await connections.own(
            "devices",
            "GET",
            undefined,
            url.searchParams.get("connectionId") ?? undefined,
          ),
        );
        return;
      }
      if (p === "/api/connections/overview") {
        json(
          res,
          200,
          await connections.own(
            "overview",
            "GET",
            undefined,
            url.searchParams.get("connectionId") ?? undefined,
          ),
        );
        return;
      }
      if (p === "/api/connections/records") {
        json(
          res,
          200,
          await connections.records(
            url.searchParams.get("connectionId") ?? undefined,
          ),
        );
        return;
      }
      if (p === "/api/connections/pending") {
        json(res, 200, connections.pending());
        return;
      }
      if (p === "/api/connections/recovery") {
        json(
          res,
          200,
          connections.savedRecovery(
            url.searchParams.get("connectionId") ?? undefined,
            url.searchParams.get("pendingId") ?? undefined,
          ),
        );
        return;
      }

      if (p === "/api/overview") {
        json(res, 200, {
          ...store.overview(),
          sources: collectionSources(),
          scan: collector.scan,
        });
        return;
      }
      if (p === "/api/sessions") {
        json(res, 200, store.sessions(url.searchParams));
        return;
      }
      const detail = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (detail) {
        const v = store.detail(
          decodeURIComponent(detail[1]),
          url.searchParams.get("before"),
        );
        if (v?.session.metadataOnly) {
          const source = collector
            .configs()
            .find((c) => c.id === v.session.sourceId);
          const history = source
            ? readDatabaseHistory(
                source.path,
                v.session.id,
                url.searchParams.get("before"),
              )
            : {
                available: false,
                events: [],
                limitation: "来源已停用或不可读",
              };
          json(res, 200, {
            ...v,
            events: history.events,
            historyAvailable: history.available,
            historyLimitation: history.limitation ?? null,
            nextBefore:
              history.events.length === 200
                ? (history.events[0]?.data.historyCursor ?? null)
                : null,
          });
          return;
        }
        json(res, v ? 200 : 404, v ?? { error: "未找到会话" });
        return;
      }
      if (p === "/api/usage") {
        json(res, 200, store.usage(url.searchParams));
        return;
      }
      if (p === "/api/sources") {
        json(res, 200, { sources: collectionSources(), scan: collector.scan });
        return;
      }
      if (p === "/api/accounts") {
        json(res, 200, store.accounts());
        return;
      }
      if (p === "/api/settings") {
        json(res, 200, settings());
        return;
      }
      if (p === "/api/sharing") {
        json(res, 200, sync.preview());
        return;
      }
      if (p === "/api/notifications") {
        json(res, 200, {
          items: (
            store.db
              .prepare(
                "SELECT json FROM notifications WHERE acked=0 ORDER BY rowid DESC LIMIT 50",
              )
              .all() as any[]
          ).map((r) => JSON.parse(r.json)),
        });
        return;
      }
      if (p === "/api/diagnostics") {
        const f = fs.existsSync(path.join(dataDir, "diagnostics.json"))
          ? path.join(dataDir, "diagnostics.json")
          : path.join(root, "work", "diagnostics.json");
        json(res, 200, {
          version: appVersion,
          historyRecovery: historyRecovery.supportFailure(),
          collector: {
            node: process.version,
            platform: process.platform,
            scan: collector.scan,
            sources: store.sources(),
            hookCleanupError: store.getSetting("hookCleanupError", null),
            hooks: {
              pendingCount: store.getSetting("hookPendingCount", 0),
              rejectedCount: store.getSetting("hookRejectedCount", 0),
              error: store.getSetting("hookQueueError", null),
              lastObservedAt: store.getSetting("lastHookObservedAt", null),
              lastReceivedAt: store.getSetting("lastHookReceivedAt", null),
            },
            diskBytes: store.diskBytes(),
          },
          capabilities: fs.existsSync(f)
            ? JSON.parse(fs.readFileSync(f, "utf8"))
            : { status: "尚未运行 npm run diagnose" },
          limitations: store.overview().limitations,
          sync: {
            status: sync.status,
            pending: (
              store.db
                .prepare("SELECT count(*) n FROM outbox WHERE acked=0")
                .get() as any
            ).n,
            rejected: store.getSetting("syncRejected", []),
          },
        });
        return;
      }
      if (p === "/api/export") {
        const filters = new URLSearchParams(url.searchParams);
        for (const key of ["cursor", "format", "page", "pageSize"])
          filters.delete(key);
        filters.sort();
        const batch = localExports.page(
          filters.toString(),
          url.searchParams.get("cursor"),
          () => {
            const all: ReturnType<typeof safeSessions> = [];
            store.db.exec("BEGIN");
            try {
              for (let page = 1; ; page++) {
                const query = new URLSearchParams(filters);
                query.set("page", String(page));
                const items = safeSessions(query);
                all.push(...items);
                if (items.length < 200) break;
              }
              store.db.exec("COMMIT");
            } catch (error) {
              store.db.exec("ROLLBACK");
              throw error;
            }
            return all;
          },
        );
        const rows = batch.items.filter(
          (item) =>
            !store.db
              .prepare("SELECT 1 FROM tombstones WHERE session_id=?")
              .get(item.sessionId),
        );
        if (url.searchParams.get("format") === "csv") {
          const keys = Object.keys(rows[0] ?? { sessionId: 0 });
          const csv =
            "\uFEFF" +
            keys.join(",") +
            "\r\n" +
            rows
              .map((r) =>
                keys
                  .map(
                    (k) =>
                      '"' +
                      String((r as any)[k] ?? "")
                        .replace(/^[=+@-]/, "'$&")
                        .replaceAll('"', '""') +
                      '"',
                  )
                  .join(","),
              )
              .join("\r\n");
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="ai-work-monitor-batch.csv"',
          });
          res.end(csv);
        } else
          json(res, 200, {
            items: rows,
            metadataOnly: true,
            count: rows.length,
            nextCursor: batch.nextCursor,
            snapshotAt: batch.snapshotAt,
            snapshotCount: batch.snapshotCount,
            range:
              "导出开始时的会话快照；后续新增不纳入，已删除记录跳过；15分钟有效",
          });
        store.audit("export-metadata", String(rows.length));
        return;
      }
    }
    if (req.method === "POST") {
      const v = await body(req);
      if (maintenance || shuttingDown) { json(res, 503, { error: "监控服务正在维护或退出，请稍后" }); return; }
      if (p === "/api/history-recovery/preview") {
        try { json(res, 200, await historyRecovery.preview(v.file)); }
        catch (error) { throw Error(historyRecovery.reportFailure(error, "preview")); }
        return;
      }
      if (p === "/api/history-recovery/apply") {
        try { json(res, 200, await historyRecovery.apply(v.file, v.token)); }
        catch (error) { throw Error(historyRecovery.reportFailure(error, "apply")); }
        return;
      }
      if (p === "/api/diagnose") {
        runDiagnostics();
        json(res, 202, { ok: true, running: true });
        return;
      }
      if (p === "/api/scan") {
        trackScan(collector.run());
        json(res, 202, { ok: true });
        return;
      }
      if (p === "/api/rebuild") {
        trackScan(collector.rebuild());
        json(res, 202, { ok: true });
        return;
      }
      if (p === "/api/backup") {
        json(res, 200, { ok: true, file: await store.backup() });
        return;
      }
      if (p === "/api/restore") {
        if (historyRecovery.busy) throw Error("请等待历史修复操作结束");
        if (
          sync.grants().some((g) => !g.revoked) ||
          store.getSetting<string[]>("pendingRevocations", []).length
        )
          throw Error("请先撤回全部共享并等待中心确认，再恢复本地备份");
        if (typeof v.file !== "string" || !/^monitor-\d+\.sqlite$/.test(v.file))
          throw Error("只能恢复本产品备份列表中的文件");
        const file = path.join(dataDir, "backups", v.file);
        const candidate = new DatabaseSync(file, { readOnly: true });
        try {
          if (
            (candidate.prepare("PRAGMA integrity_check").get() as any)
              .integrity_check !== "ok" ||
            ![1, 2, 3].includes(
              Number(
                (candidate.prepare("PRAGMA user_version").get() as any)
                  .user_version,
              ),
            )
          )
            throw Error("备份校验或版本不兼容");
        } catch (e) {
          candidate.close();
          throw e;
        }
        ownsMaintenance = true;
        const tmp = path.join(dataDir, "restore.sqlite");
        let previousSelectionRevision: number, tombstones: any[];
        try {
          await pauseMonitorWrites();
          // A request admitted before maintenance may have just granted sharing.
          // Recheck after it finishes, before replacing any current data.
          if (
            sync.grants().some((g) => !g.revoked) ||
            store.getSetting<string[]>("pendingRevocations", []).length
          )
            throw Error("请先撤回全部共享并等待中心确认，再恢复本地备份");
          previousSelectionRevision = sync.selectionRevision();
          tombstones = store.db.prepare("SELECT * FROM tombstones").all() as any[];
          await store.backup();
          await backup(candidate, tmp);
        } finally {
          candidate.close();
        }
        store.close();
        for (const suffix of ["-wal", "-shm"])
          if (fs.existsSync(store.file + suffix))
            fs.unlinkSync(store.file + suffix);
        fs.renameSync(tmp, store.file);
        store.db = new DatabaseSync(store.file);
        store.db.exec("PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;");
        store.migrate();
        for (const t of tombstones) store.deleteSession(t.session_id);
        store.db.exec("UPDATE grants SET revoked=1;DELETE FROM outbox;");
        store.setSetting("hubPair", null);
        store.setSetting("hubPairs", []);
        store.setSetting("productIdentities", {});
        store.setSetting("pendingRegistrations", {});
        store.setSetting("completedInvitations", {});
        store.setSetting("activeHubPair", null);
        store.setSetting(
          "activeHubSelectionRevision",
          Math.max(previousSelectionRevision, sync.selectionRevision()) + 1,
        );
        store.audit("restore", "remote-auth-cleared");
        resumeMonitorWrites();
        json(res, 200, {
          ok: true,
          message: "已恢复；保留永久删除标记，中心需重新配对授权",
        });
        return;
      }
      if (p === "/api/settings") {
        const old = {
          ...defaults,
          ...store.getSetting<any>("preferences", {}),
        };
        const next = { ...old };
        if (v.pollMs !== undefined)
          next.pollMs = Math.max(
            500,
            Math.min(60000, Number(v.pollMs) || 1500),
          );
        if (v.staleMs !== undefined)
          next.staleMs = Math.max(
            5000,
            Math.min(300000, Number(v.staleMs) || 15000),
          );
        if (v.notifications)
          next.notifications = {
            enabled: !!v.notifications.enabled,
            quietStart: Math.max(
              0,
              Math.min(23, Number(v.notifications.quietStart) || 0),
            ),
            quietEnd: Math.max(
              0,
              Math.min(23, Number(v.notifications.quietEnd) || 0),
            ),
            quotaThreshold: Math.max(
              1,
              Math.min(99, Number(v.notifications.quotaThreshold) || 15),
            ),
          };
        if (v.retentionDays !== undefined && Number(v.retentionDays) !== 0)
          throw Error(
            "本地自动保留清理尚未启用，请使用会话永久删除；中心按授权保留期限执行",
          );
        if (v.hooksEnabled !== undefined) {
          if (typeof v.hooksEnabled !== "boolean")
            throw Error("开关必须为布尔值");
          let cleanupError: string | null = null;
          if (v.hooksEnabled) {
            configureHooks(dataDir, true);
          } else {
            hookGate(dataDir, false);
            try {
              cleanupError = configureHooks(dataDir, false).cleanupError;
            } catch (error) {
              cleanupError =
                "已停止接收，但配置清理未完成：" + (error as Error).message;
            }
          }
          next.hooksEnabled = v.hooksEnabled;
          store.setSetting("hookCleanupError", cleanupError);
          const q = path.join(dataDir, "hook-queue.jsonl");
          store.setSetting(
            "hookQueueOffset",
            fs.existsSync(q) ? fs.statSync(q).size : 0,
          );
          store.setSetting("lastHookObservedAt", null);
          store.audit("hooks-opt-in", String(next.hooksEnabled));
        }
        store.setSetting("preferences", next);
        json(res, 200, settings());
        return;
      }
      if (p === "/api/accounts") {
        if (
          typeof v.label !== "string" ||
          v.label.length < 1 ||
          v.label.length > 80
        )
          throw Error("账号别名需要 1–80 字符");
        const id = "manual:" + randomUUID();
        store.db
          .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
          .run(id, v.label, "codex", "manual");
        store.audit("create-account", id);
        json(res, 201, { id });
        return;
      }
      if (p === "/api/bindings") {
        json(res, 201, { id: store.createBinding(v) });
        return;
      }
      if (p === "/api/sources") {
        if (
          typeof v.path !== "string" ||
          !path.isAbsolute(v.path) ||
          !fs.statSync(v.path).isDirectory()
        )
          throw Error("需要可读的绝对数据目录");
        const configs = collector.configs();
        if (
          configs.some(
            (c) =>
              path.resolve(c.path).toLowerCase() ===
              path.resolve(v.path).toLowerCase(),
          )
        )
          throw Error("此数据目录已存在");
        const id = randomUUID();
        store.setSetting("sourceConfigs", [
          ...configs,
          {
            id,
            path: path.resolve(v.path),
            label: String(v.label || "额外来源").slice(0, 80),
            kind: String(v.kind || "manual"),
            environmentId: randomUUID(),
          },
        ]);
        store.audit("add-source", id);
        void collector.run().catch(() => {});
        json(res, 201, { id });
        return;
      }
      const note = p.match(/^\/api\/sessions\/([^/]+)\/note$/);
      if (note) {
        if (typeof v.notes !== "string" || v.notes.length > 20000)
          throw Error("备注超出限制");
        store.db
          .prepare("UPDATE sessions SET notes=?,pinned=? WHERE id=?")
          .run(v.notes, v.pinned ? 1 : 0, decodeURIComponent(note[1]));
        json(res, 200, { ok: true });
        return;
      }
      const ack = p.match(/^\/api\/notifications\/([^/]+)\/ack$/);
      if (ack) {
        store.db
          .prepare("UPDATE notifications SET acked=1 WHERE id=?")
          .run(decodeURIComponent(ack[1]));
        json(res, 200, { ok: true });
        return;
      }
      if (p === "/api/quota/bind") {
        const current = (
          store.db
            .prepare(
              "SELECT value FROM settings WHERE key LIKE 'quotaIdentity:%'",
            )
            .all() as any[]
        )
          .map((r) => JSON.parse(r.value))
          .find((x) => x.sourceId === v.sourceId);
        if (!current || current.confirmed)
          throw Error("请选择当前未确认的额度来源");
        const q = store.quotas().find((x) => x.sourceId === v.sourceId);
        if (!q || Date.now() - Date.parse(q.observedAt) > 120000)
          throw Error("请先刷新额度，再确认来源");
        const to = new Date(v.to).toISOString();
        if (
          Date.parse(to) <= Date.now() ||
          Date.parse(to) > Date.now() + 90 * 86400000
        )
          throw Error("确认有效期应在未来 90 天以内");
        const id = store.createBinding({
          accountId: v.accountId,
          sourceId: v.sourceId,
          from: q.observedAt,
          to,
        });
        json(res, 201, { id });
        return;
      }
      if (p === "/api/connections/preview") {
        json(res, 200, await connections.preview(String(v.link)));
        return;
      }
      if (p === "/api/connections/accept") {
        json(
          res,
          201,
          await connections.accept(String(v.link), String(v.name ?? "")),
        );
        return;
      }
      if (p === "/api/connections/login") {
        json(res, 200, await connections.login(v));
        return;
      }
      if (p === "/api/connections/resume") {
        json(res, 200, await connections.resume(String(v.pendingId ?? "")));
        return;
      }
      if (p === "/api/connections/restart-registration") {
        json(res, 200, await connections.restartRegistration(String(v.pendingId ?? ""), String(v.recoveryCode ?? "")));
        return;
      }
      if (p === "/api/connections/pair-code") {
        json(res, 201, await connections.pairCode(v.connectionId));
        return;
      }
      if (p === "/api/connections/rotate") {
        json(res, 200, await connections.rotate(v.connectionId));
        return;
      }
      if (p === "/api/connections/recovery") {
        json(res, 200, await connections.recovery(v.connectionId));
        return;
      }
      const pause = p.match(/^\/api\/sharing\/([^/]+)\/pause$/);
      if (pause) {
        connections.confirmGrant(decodeURIComponent(pause[1]), v.connectionId);
        json(
          res,
          200,
          sync.pause(decodeURIComponent(pause[1]), v.paused === true),
        );
        return;
      }
      if (p === "/api/quota/refresh") {
        const { refreshQuota } = await import("../collector/quota.js");
        const result = await refreshQuota(store);
        json(res, result.ok ? 200 : 502, result);
        return;
      }
      if (p === "/api/sync/select") {
        json(res, 200, sync.selectPair(String(v.id)));
        return;
      }
      if (p === "/api/sync/pair") {
        json(res, 200, await sync.pair(v));
        return;
      }
      if (p === "/api/sharing") {
        json(res, 201, await sync.grant(v));
        return;
      }
    }
    if (req.method === "DELETE") {
      const deleteBody = await body(req);
      if (maintenance || shuttingDown) { json(res, 503, { error: "监控服务正在维护或退出，请稍后" }); return; }
      const queryConnection = url.searchParams.get("connectionId");
      if (
        queryConnection &&
        deleteBody.connectionId &&
        queryConnection !== deleteBody.connectionId
      )
        throw Error("接收方不一致，请重新确认目标连接");
      const connectionId =
        deleteBody.connectionId ?? queryConnection ?? undefined;
      const ownDevice = p.match(/^\/api\/connections\/devices\/([^/]+)$/);
      if (ownDevice) {
        json(
          res,
          200,
          await connections.own(
            "devices/" + encodeURIComponent(ownDevice[1]),
            "DELETE",
            undefined,
            connectionId,
          ),
        );
        return;
      }

      const session = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (session) {
        const id = decodeURIComponent(session[1]);
        store.deleteSession(id);
        await sync.erase(id);
        json(res, 200, { ok: true });
        return;
      }
      const binding = p.match(/^\/api\/bindings\/([^/]+)$/);
      if (binding) {
        const id = decodeURIComponent(binding[1]);
        const existing = store.db
          .prepare("SELECT account_id FROM bindings WHERE id=?")
          .get(id) as any;
        if (
          existing &&
          (sync
            .grants()
            .some(
              (g) => !g.revoked && g.accountIds?.includes(existing.account_id),
            ) ||
            store.getSetting<string[]>("pendingRevocations", []).length)
        )
          throw Error("请先撤回相关共享授权并等待中心确认，再撤销账号时间映射");
        store.db.prepare("UPDATE bindings SET revoked=1 WHERE id=?").run(id);
        store.audit("revoke-binding", id);
        json(res, 200, { ok: true });
        return;
      }
      const source = p.match(/^\/api\/sources\/([^/]+)$/);
      if (source) {
        const id = decodeURIComponent(source[1]);
        const configs = collector.configs();
        if (!configs.some((config) => config.id === id)) {
          json(res, 200, { ok: true, collectionEnabled: false });
          return;
        }
        store.setSetting(
          "sourceConfigs",
          configs.filter((c) => c.id !== id),
        );
        // Stop future collection without deleting provenance used by history,
        // account associations or a scan which was already in flight.
        store.audit("stop-collector-source", id);
        json(res, 200, { ok: true });
        return;
      }
      const grant = p.match(/^\/api\/sharing\/([^/]+)$/);
      if (grant) {
        connections.confirmGrant(decodeURIComponent(grant[1]), connectionId);
        json(res, 200, await sync.revoke(decodeURIComponent(grant[1])));
        return;
      }
    }
    if (p.startsWith("/api/")) {
      json(res, 404, { error: "没有此监控接口" });
      return;
    }
    const ui = path.join(root, "dist", "ui");
    let file = path.resolve(ui, "." + decodeURIComponent(p));
    if (!file.startsWith(ui + path.sep) && file !== ui) {
      json(res, 403, { error: "路径不允许" });
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(ui, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("界面尚未构建，请运行 npm run build");
      return;
    }
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (ownsMaintenance && maintenance) {
      resumeMonitorWrites();
    }
    json(res, 400, {
      error: e instanceof Error ? e.message.slice(0, 180) : "操作失败",
    });
  } finally {
    activeApi.delete(res);
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `AI Work Monitor: http://127.0.0.1:${port}/?launch=${launchToken}`,
  );
  collector.start();
  sync.start();
  if (process.env.AIWM_QUOTA_DISABLED !== "1") quotaScheduler.start();
  if (!fs.existsSync(path.join(dataDir, "diagnostics.json"))) runDiagnostics();
});
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Let a transaction-backed recovery finish; do not close its live connection
  // halfway through preparing a consistent backup or applying the transaction.
  while (historyRecovery.busy) await new Promise((resolve) => setTimeout(resolve, 20));
  quotaScheduler.stop();
  collector.stop();
  sync.stop();
  const { refreshQuota } = await import("../collector/quota.js");
  await refreshQuota.cancel(store);
  while (activeApi.size || manualScans.size || historyRecovery.busy || sync.running || collector.scan.phase === "scanning")
    await new Promise((resolve) => setTimeout(resolve, 20));
  for (const r of viewers) r.end();
  server.close(() => {
    store.close();
    if (process.connected)
      process.send?.({ type: "shutdown-complete" }, () => process.exit(0));
    else process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("message", (message) => {
  if ((message as any)?.type === "shutdown") void shutdown();
});
process.on("disconnect", () => void shutdown());
