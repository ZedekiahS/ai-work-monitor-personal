import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldNow } from "node:timers/promises";
import { Store } from "../core/store.js";
import { ParserContext, Scan, Source, hash } from "../core/model.js";
import { parseLine } from "./codex.js";
import { readHookQueue } from "./hooks.js";
import { importDatabaseMetadata } from "./database.js";
export interface SourceConfig {
  id: string;
  path: string;
  label: string;
  kind: string;
  environmentId: string;
}
export class Collector {
  pendingImport = false;
  scan: Scan = {
    phase: "idle",
    filesTotal: 0,
    filesDone: 0,
    eventsImported: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
  };
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped = false;
  watchers: fs.FSWatcher[] = [];
  rescan = false;
  lastDatabaseScan = new Map<string, number>();
  private baselineBackup: Promise<string> | undefined;
  constructor(
    public store: Store,
    public onChange: () => void = () => {},
  ) {
    if (!store.getSetting("deviceId", ""))
      store.setSetting("deviceId", randomUUID());
    if (!store.getSetting("environmentId", ""))
      store.setSetting("environmentId", randomUUID());
    if (!store.getSetting<SourceConfig[] | null>("sourceConfigs", null)) {
      const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
      store.setSetting("sourceConfigs", [
        {
          id: randomUUID(),
          path: home,
          label: "本机 Codex 历史",
          kind:
            process.platform === "win32" ? "windows-desktop-or-cli" : "native",
          environmentId: store.getSetting("environmentId", "unknown"),
        },
      ]);
    }
  }
  configs() {
    return this.store.getSetting<SourceConfig[]>("sourceConfigs", []);
  }
  start() {
    this.stopped = false;
    for (const c of this.configs()) {
      try {
        this.watchers.push(
          fs.watch(c.path, { recursive: true }, (_, f) => {
            if (f?.endsWith(".jsonl")) this.rescan = true;
          }),
        );
      } catch {}
    }
    void this.tick();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
  async tick() {
    if (this.stopped) return;
    try {
      await this.run();
      this.store.setSetting("collectorHealth", {
        health: this.scan.errors ? "error" : "healthy",
        observedAt: new Date().toISOString(),
      });
    } catch {
      this.store.setSetting("collectorHealth", {
        health: "error",
        observedAt: new Date().toISOString(),
      });
      this.scan.phase = "error";
      this.scan.errors++;
      this.onChange();
    } finally {
      if (!this.stopped)
        this.timer = setTimeout(
          () => void this.tick(),
          this.store.getSetting<any>("preferences", {}).pollMs ?? 1500,
        );
    }
  }
  async run() {
    if (this.scan.phase === "scanning") return;
    this.pendingImport = false;
    this.scan = {
      phase: "scanning",
      filesTotal: 0,
      filesDone: 0,
      eventsImported: 0,
      errors: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.onChange();
    for (const c of this.configs()) {
      let errors = 0;
      const errorStart = this.scan.errors;
      const source: Source = {
        id: c.id,
        label: c.label,
        kind: c.kind,
        environmentId: c.environmentId,
        pathLabel: path.basename(c.path),
        health: "scanning",
        lastScanAt: null,
        errorCount: 0,
        capabilities: {
          history: "真实日志读取",
          live: "日志生命周期事件；静默未知",
          agents: "会话头 parent/spawn 关系",
          quota: "日志快照；正式接口需主动刷新",
        },
      };
      this.store.source(source);
      try {
        const roots = ["sessions", "archived_sessions"].map((p) =>
          path.join(c.path, p),
        );
        if (!roots.some((p) => fs.existsSync(p)))
          throw Error("source-unavailable");
        const files: string[] = [];
        for (const root of roots) {
          if (fs.existsSync(root))
            for (const f of fs.readdirSync(root, { recursive: true }))
              if (typeof f === "string" && f.endsWith(".jsonl"))
                files.push(path.join(root, f));
        }
        this.scan.filesTotal += files.length;
        for (const file of files) {
          if (this.stopped) break;
          try {
            this.scan.eventsImported += await this.ingestFile(file, c);
          } catch {
            errors++;
            this.scan.errors++;
          }
          this.scan.filesDone++;
          if (this.scan.filesDone % 5 === 0) {
            this.store.projectDirty();
            this.onChange();
          }
          await yieldNow();
        }
        if (Date.now() - (this.lastDatabaseScan.get(c.id) ?? 0) > 30000) {
          this.scan.eventsImported += importDatabaseMetadata(
            this.store,
            c.path,
            c.id,
            c.environmentId,
          );
          this.lastDatabaseScan.set(c.id, Date.now());
        }
        source.health = errors ? "degraded" : "healthy";
        source.lastScanAt = new Date().toISOString();
      } catch {
        source.health = "unavailable";
        errors++;
        this.scan.errors++;
      }
      source.errorCount = Math.max(errors, this.scan.errors - errorStart);
      if (source.errorCount && source.health === "healthy")
        source.health = "degraded";
      if (source.errorCount)
        this.store.notify(
          "collector-error:" + c.id + new Date().toISOString().slice(0, 10),
          "采集来源需要检查",
          "来源不可读或部分记录无法解析；这不代表 Agent 任务失败。",
        );
      this.store.source(source);
    }
    this.scan.eventsImported += readHookQueue(this.store);
    this.store.projectDirty();
    this.scan.phase = "idle";
    if (!this.pendingImport) this.store.setSetting("indexRebuilding", false);
    this.scan.finishedAt = new Date().toISOString();
    this.onChange();
  }
  async ingestFile(
    file: string,
    c: SourceConfig,
    options: { backupAlreadyTaken?: boolean; baselineOnly?: boolean } = {},
  ) {
    const info = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    let count = 0;
    try {
      const head = Buffer.alloc(Math.min(128, info.size));
      fs.readSync(fd, head, 0, head.length, 0);
      const signature = hash(head.toString("hex"));
      const previous = this.store.db
        .prepare("SELECT * FROM cursors WHERE path=?")
        .get(file) as any;
      let offset =
        previous &&
        previous.signature === signature &&
        previous.offset <= info.size
          ? previous.offset
          : 0;
      const previousContext: ParserContext | undefined = offset
        ? JSON.parse(previous.context)
        : undefined;
      const needsBaselineReplay =
        !!previousContext &&
        (previousContext.cutoff !== null || previousContext.forked) &&
        (previousContext.baselineParsingVersion ?? 0) < 1;
      if (options.baselineOnly && !needsBaselineReplay)
        throw Error(
          "Indexed source changed or its baseline has already been checked",
        );
      if (needsBaselineReplay) {
        // The old parser discarded inherited counters before projection. Merely
        // recomputing its stored events cannot recover the missing baseline.
        // Re-read the source without deleting any events, annotations or queues.
        if (!options.backupAlreadyTaken)
          await (this.baselineBackup ??= this.store.backup());
        offset = 0;
      }
      let context: ParserContext = offset
        ? JSON.parse(previous.context)
        : {
            deviceId: this.store.getSetting("deviceId", "unknown"),
            environmentId: c.environmentId,
            sourceId: c.id,
            sessionId: path.basename(file, ".jsonl"),
            accountId: null,
            projectId: "unknown",
            turnId: null,
            model: "未知",
            cutoff: null,
            forked: false,
            hasResponseUsage: false,
            baselineParsingVersion: 1,
          };
      if (offset === info.size) return 0;
      const limit = options.baselineOnly
        ? previous.offset
        : Math.min(info.size, offset + 64 * 1024 * 1024);
      const errorsBefore = this.scan.errors;
      if (!options.baselineOnly && limit < info.size) this.pendingImport = true;
      let pending = Buffer.alloc(0),
        position = offset;
      while (position < limit) {
        const buf = Buffer.alloc(Math.min(1024 * 1024, limit - position));
        const n = fs.readSync(fd, buf, 0, buf.length, position);
        if (!n) break;
        position += n;
        pending = Buffer.concat([pending, buf.subarray(0, n)]);
        let start = 0;
        const parsed: ReturnType<typeof parseLine>[] = [];
        for (
          let end = pending.indexOf(10, start);
          end >= 0;
          end = pending.indexOf(10, start)
        ) {
          const raw = pending.subarray(start, end).toString("utf8").trim();
          try {
            if (raw) {
              const event = parseLine(raw, context, offset + start);
              if (
                options.baselineOnly &&
                event?.kind === "session_meta" &&
                event.sessionId !== previousContext!.sessionId
              )
                throw Error("Source session identity changed");
              parsed.push(event);
            }
          } catch {
            this.scan.errors++;
          }
          start = end + 1;
        }
        if (start) {
          this.store.transaction(() => {
            for (const e of parsed)
              if (
                e &&
                (!options.baselineOnly ||
                  (e.data.baselineOnly &&
                    e.sessionId === previousContext!.sessionId)) &&
                this.store.insert(e)
              )
                count++;
            offset += start;
            if (!options.baselineOnly)
              this.store.db
                .prepare(
                  "INSERT INTO cursors VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,signature=excluded.signature,context=excluded.context",
                )
                .run(file, offset, signature, JSON.stringify(context));
          });
          pending = pending.subarray(start);
        }
        if (pending.length > 32 * 1024 * 1024) {
          this.scan.errors++;
          break;
        }
        await yieldNow();
      }
      if (
        options.baselineOnly &&
        position === limit &&
        pending.length === 0 &&
        this.scan.errors === errorsBefore &&
        context.headerSeen &&
        context.sessionId === previousContext!.sessionId
      ) {
        this.store.db
          .prepare("UPDATE cursors SET context=? WHERE path=?")
          .run(
            JSON.stringify({ ...previousContext, baselineParsingVersion: 1 }),
            file,
          );
      }
    } finally {
      fs.closeSync(fd);
    }
    return count;
  }
  async repairForkBaselines(options: { backupAlreadyTaken?: boolean } = {}) {
    const report = {
      examined: 0,
      replayed: 0,
      baselineEventsAdded: 0,
      unavailable: 0,
      incomplete: 0,
    };
    const rows = this.store.db
      .prepare("SELECT path,context FROM cursors")
      .all() as { path: string; context: string }[];
    for (const row of rows) {
      const ctx = JSON.parse(row.context) as ParserContext;
      if (
        (ctx.cutoff === null && !ctx.forked) ||
        (ctx.baselineParsingVersion ?? 0) >= 1
      )
        continue;
      report.examined++;
      const config = this.configs().find((c) => c.id === ctx.sourceId);
      if (!config || !fs.existsSync(row.path)) {
        report.unavailable++;
        continue;
      }
      try {
        const before = (
          this.store.db
            .prepare(
              "SELECT count(*) n FROM events WHERE json_extract(json,'$.data.baselineOnly')=1",
            )
            .get() as any
        ).n;
        await this.ingestFile(row.path, config, {
          ...options,
          baselineOnly: true,
        });
        const checked = this.store.db
          .prepare("SELECT context FROM cursors WHERE path=?")
          .get(row.path) as { context: string };
        if (JSON.parse(checked.context).baselineParsingVersion !== 1)
          report.incomplete++;
        report.baselineEventsAdded +=
          (
            this.store.db
              .prepare(
                "SELECT count(*) n FROM events WHERE json_extract(json,'$.data.baselineOnly')=1",
              )
              .get() as any
          ).n - before;
        report.replayed++;
      } catch {
        report.unavailable++;
      }
    }
    this.store.projectDirty();
    return report;
  }
  async rebuild() {
    if (this.scan.phase === "scanning") throw Error("请等待当前扫描结束后重建");
    await this.store.backup();
    this.store.setSetting("indexRebuilding", true);
    this.store.db.exec(
      "DELETE FROM cursors; INSERT OR IGNORE INTO pending_projection SELECT DISTINCT session_id FROM events;",
    );
    await this.run();
  }
}
