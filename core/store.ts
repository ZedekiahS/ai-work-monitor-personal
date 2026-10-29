import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encodeCursor, decodeCursor } from "./pagination.js";
import { Credentials, protectedSettings } from "./credentials.js";
import {
  Event,
  Session,
  Source,
  Usage,
  zeroUsage,
  reconcileUsage,
  applyState,
  presentState,
  Quota,
  hash,
} from "./model.js";
export class Store {
  db: DatabaseSync;
  file: string;
  dirty = new Set<string>();
  private credentials: Credentials;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    this.credentials = new Credentials(dir);
    this.file = path.join(dir, "monitor.sqlite");
    this.db = new DatabaseSync(this.file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;",
    );
    this.migrate();
    for (const key of protectedSettings) this.getSetting(key, null);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (version > 3) throw new Error("数据库版本高于此程序，拒绝降级");
    this.db
      .exec(`BEGIN; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,source_id TEXT NOT NULL,account_id TEXT,project_id TEXT NOT NULL,json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_session_time ON events(session_id,occurred_at,id); CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at); CREATE INDEX IF NOT EXISTS events_account_time ON events(account_id,occurred_at);
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,project TEXT NOT NULL,project_id TEXT NOT NULL,model TEXT NOT NULL,source_id TEXT NOT NULL,account_id TEXT,parent_id TEXT,relation TEXT,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL,evidence TEXT NOT NULL,usage TEXT NOT NULL,total_tokens INTEGER NOT NULL DEFAULT 0,uncertain INTEGER NOT NULL DEFAULT 0,notes TEXT NOT NULL DEFAULT '',pinned INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC); CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id); CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state,updated_at DESC); CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id,updated_at DESC);
 CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cursors(path TEXT PRIMARY KEY,offset INTEGER NOT NULL,signature TEXT NOT NULL,context TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,label TEXT NOT NULL,provider TEXT NOT NULL,evidence TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),source_id TEXT NOT NULL,from_at TEXT NOT NULL,to_at TEXT NOT NULL,evidence TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS quotas(id TEXT PRIMARY KEY,account_id TEXT,pool TEXT NOT NULL,window TEXT NOT NULL,observed_at TEXT NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS quotas_latest ON quotas(account_id,pool,window,observed_at DESC);
 CREATE TABLE IF NOT EXISTS tombstones(session_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS annotations(session_id TEXT PRIMARY KEY,notes TEXT NOT NULL,pinned INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,json TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,grant_id TEXT NOT NULL,json TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,grant_id));
 CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,json TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS pending_projection(session_id TEXT PRIMARY KEY); INSERT OR IGNORE INTO pending_projection SELECT DISTINCT session_id FROM events WHERE session_id NOT IN (SELECT id FROM sessions); CREATE TABLE IF NOT EXISTS usage_points(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,occurred_at TEXT NOT NULL,model TEXT NOT NULL,project_id TEXT NOT NULL,account_id TEXT,usage TEXT NOT NULL,event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS usage_points_time ON usage_points(occurred_at); CREATE INDEX IF NOT EXISTS usage_points_session ON usage_points(session_id);
 COMMIT;`);
    const sessionColumns = new Set(
      (this.db.prepare("PRAGMA table_info(sessions)").all() as any[]).map(
        (r) => r.name,
      ),
    );
    if (!sessionColumns.has("state_at"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN state_at TEXT");
    if (!sessionColumns.has("state_observed_at"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN state_observed_at TEXT");
    this.db.exec("PRAGMA user_version=3");
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    if (!r) return fallback;
    const value = JSON.parse(r.value);
    if (!protectedSettings.has(key)) return value;
    try {
      const plain = this.credentials.open(value);
      if (
        value?.encrypted !== 1 &&
        plain &&
        (!Array.isArray(plain) || plain.length)
      )
        this.setSetting(key, plain);
      return plain;
    } catch {
      return fallback;
    }
  }
  setSetting(key: string, value: any) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        key,
        JSON.stringify(
          protectedSettings.has(key) &&
            value &&
            (!Array.isArray(value) || value.length)
            ? this.credentials.seal(value)
            : value,
        ),
      );
  }
  audit(action: string, subject: string) {
    this.db
      .prepare("INSERT INTO audit(at,action,subject) VALUES(?,?,?)")
      .run(new Date().toISOString(), action, subject);
  }
  source(s: Source) {
    this.db
      .prepare(
        "INSERT INTO sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(s.id, JSON.stringify(s));
  }
  sources(): Source[] {
    return (this.db.prepare("SELECT json FROM sources").all() as any[]).map(
      (r) => JSON.parse(r.json),
    );
  }
  insert(e: Event): boolean {
    if (
      this.db
        .prepare("SELECT 1 FROM tombstones WHERE session_id=?")
        .get(e.sessionId)
    )
      return false;
    const result = this.db
      .prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        e.id,
        e.sessionId,
        e.turnId,
        e.kind,
        e.occurredAt,
        e.sourceId,
        e.accountId,
        e.projectId,
        JSON.stringify(e),
      );
    if (!result.changes) return false;
    if (e.accountId)
      this.db
        .prepare("INSERT OR IGNORE INTO accounts VALUES(?,?,?,?)")
        .run(
          e.accountId,
          "Codex 创建账号 " + e.accountId.slice(-6),
          "codex",
          "session_header",
        );
    this.dirty.add(e.sessionId);
    this.db
      .prepare("INSERT OR IGNORE INTO pending_projection VALUES(?)")
      .run(e.sessionId);
    if (e.kind === "usage_snapshot" && e.data.rateLimits) {
      const limits = e.data.rateLimits;
      for (const [key, v] of Object.entries(limits)) {
        if (!v || typeof v !== "object") continue;
        const w = v as any;
        if (typeof w.used_percent !== "number") continue;
        const duration = w.window_minutes ?? key;
        this.addQuota({
          id: "quota:" + hash(e.id + key),
          accountId: "unknown:source:" + e.sourceId,
          identityEvidence: "unconfirmed",
          pool: limits.limit_id ?? "codex",
          window: String(duration),
          remainingPercent: Math.max(0, Math.min(100, 100 - w.used_percent)),
          resetsAt:
            typeof w.resets_at === "number"
              ? new Date(w.resets_at * 1000).toISOString()
              : null,
          observedAt: e.occurredAt,
          freshness: "stale",
          sourceId: e.sourceId,
        });
      }
    }
    const notifications = this.getSetting<any>("preferences", {}).notifications;
    if (
      notifications?.enabled &&
      [
        "turn_completed",
        "turn_failed",
        "turn_cancelled",
        "waiting_user",
        "waiting_approval",
      ].includes(e.kind) &&
      Date.now() - Date.parse(e.occurredAt) < 60000
    ) {
      const d = new Date();
      const hour = d.getHours();
      const start = Number(notifications.quietStart ?? 22),
        end = Number(notifications.quietEnd ?? 8);
      const quiet =
        start === end
          ? false
          : start > end
            ? hour >= start || hour < end
            : hour >= start && hour < end;
      if (!quiet)
        this.db
          .prepare("INSERT OR IGNORE INTO notifications(id,json) VALUES(?,?)")
          .run(
            e.id,
            JSON.stringify({
              id: e.id,
              title: "任务状态更新",
              body: e.kind,
              createdAt: e.occurredAt,
            }),
          );
    }
    return true;
  }
  addQuota(q: Quota) {
    this.db
      .prepare("INSERT OR IGNORE INTO quotas VALUES(?,?,?,?,?,?)")
      .run(
        q.id,
        q.accountId,
        q.pool,
        q.window,
        q.observedAt,
        JSON.stringify(q),
      );
    const pref = this.getSetting<any>("preferences", {}).notifications;
    if (
      pref?.enabled &&
      q.accountId &&
      !q.accountId.startsWith("unknown:") &&
      q.remainingPercent !== null &&
      q.remainingPercent <= Number(pref.quotaThreshold ?? 15) &&
      Date.now() - Date.parse(q.observedAt) < 120000 &&
      (!q.resetsAt || Date.parse(q.resetsAt) > Date.now())
    )
      this.notify(
        "low-quota:" +
          hash(
            q.accountId +
              q.pool +
              q.window +
              (q.resetsAt ?? q.observedAt.slice(0, 10)) +
              String(pref.quotaThreshold ?? 15),
          ),
        "账号额度偏低",
        `${q.pool} / ${q.window} 分钟窗口：剩余 ${q.remainingPercent}%（账号级观察）`,
      );
  }
  notify(id: string, title: string, body: string) {
    const pref = this.getSetting<any>("preferences", {}).notifications;
    if (!pref?.enabled) return;
    const hour = new Date().getHours(),
      start = Number(pref.quietStart ?? 22),
      end = Number(pref.quietEnd ?? 8);
    if (
      start !== end &&
      (start > end ? hour >= start || hour < end : hour >= start && hour < end)
    )
      return;
    this.db
      .prepare("INSERT OR IGNORE INTO notifications(id,json) VALUES(?,?)")
      .run(
        id,
        JSON.stringify({
          id,
          title,
          body,
          createdAt: new Date().toISOString(),
        }),
      );
  }
  quotas(): Quota[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `WITH mapped AS (
      SELECT q.*, (SELECT b.account_id FROM bindings b WHERE b.source_id=json_extract(q.json,'$.sourceId') AND b.revoked=0 AND b.evidence='manual' AND b.from_at<=q.observed_at AND b.to_at>q.observed_at ORDER BY b.from_at DESC LIMIT 1) mapped_account FROM quotas q
    ), grouped AS (SELECT *, CASE
      WHEN mapped_account IS NOT NULL THEN 'account:'||mapped_account
      WHEN account_id IS NOT NULL AND account_id NOT LIKE 'unknown:%' THEN 'account:'||account_id
      WHEN json_extract(json,'$.displaySourceId') IS NOT NULL THEN 'observation:'||json_extract(json,'$.displaySourceId')
      WHEN json_extract(json,'$.sourceId') LIKE 'quota-probe:%' THEN 'observation:legacy-local-quota-probe'
      ELSE 'observation:'||COALESCE(json_extract(json,'$.sourceId'),'unknown') END display_group FROM mapped
    ) SELECT json,mapped_account,display_group,history_count FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY display_group,pool,window ORDER BY observed_at DESC,id DESC) rn, COUNT(*) OVER(PARTITION BY display_group,pool,window) history_count FROM grouped) WHERE rn=1`,
      )
      .all() as any[];
    const visible = rows.filter(
      (r) =>
        r.display_group !== "observation:legacy-local-quota-probe" ||
        !rows.some((other) => {
          const a = JSON.parse(r.json),
            b = JSON.parse(other.json);
          return (
            b.displaySourceId && a.pool === b.pool && a.window === b.window
          );
        }),
    );
    return visible.map((r) => {
      const q = JSON.parse(r.json),
        accountId = r.mapped_account ?? q.accountId;
      return {
        ...q,
        accountId,
        identityEvidence: r.mapped_account ? "manual" : q.identityEvidence,
        displayGroup: r.display_group,
        unbound: !accountId || accountId.startsWith("unknown:"),
        historyCount: r.history_count,
        freshness:
          now - Date.parse(q.observedAt) < 120000 &&
          (!q.resetsAt || Date.parse(q.resetsAt) > now)
            ? "fresh"
            : "stale",
      };
    });
  }
  allEvents(id: string): Event[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM events WHERE session_id=? ORDER BY occurred_at,id",
        )
        .all(id) as any[]
    )
      .map((r) => JSON.parse(r.json))
      .sort(
        (a, b) =>
          a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence,
      );
  }
  projectDirty() {
    for (const r of this.db
      .prepare("SELECT session_id FROM pending_projection")
      .all() as any[])
      this.dirty.add(r.session_id);
    for (const id of this.dirty) {
      this.db.exec("BEGIN");
      try {
        const events = this.allEvents(id);
        if (!events.length) {
          this.db.exec("COMMIT");
          continue;
        }
        const old = (this.db
          .prepare("SELECT notes,pinned FROM sessions WHERE id=?")
          .get(id) ??
          this.db
            .prepare("SELECT notes,pinned FROM annotations WHERE session_id=?")
            .get(id)) as any;
        const meta =
          events.find(
            (e) =>
              e.kind === "session_meta" && e.data.sourceKind !== "database",
          ) ?? events.find((e) => e.kind === "session_meta");
        const metadataOnly = meta?.data.metadataOnly === true;
        const ownedEvents = events.filter((e) => !e.data.inherited);
        const first = ownedEvents[0] ?? events[0];
        const last = ownedEvents.at(-1) ?? events.at(-1)!;
        const result = reconcileUsage(events);
        const hookParents = [
          ...new Set(
            events
              .filter(
                (e) =>
                  e.data.relationEvidence === "hook_contract" &&
                  typeof e.data.parentId === "string" &&
                  e.data.parentId !== id,
              )
              .map((e) => e.data.parentId as string),
          ),
        ];
        const fallbackParent = hookParents.length === 1 ? hookParents[0] : null;
        let state: {
          state: Session["state"];
          turnId: string | null;
          at: string;
          evidence: Session["evidence"];
          observedAt?: string;
        } = {
          state: "unknown" as Session["state"],
          turnId: null as string | null,
          at: first.occurredAt,
          observedAt: first.observedAt,
          evidence: "unknown" as Session["evidence"],
        };
        let model = "未知";
        let title = meta?.data.title ?? "Codex 会话";
        for (const e of ownedEvents) {
          state = applyState(state, e);
          if (e.data.model) model = e.data.model;
          if (
            title === "Codex 会话" &&
            e.kind === "user_message" &&
            e.data.text &&
            !e.data.text.startsWith("<")
          )
            title = e.data.text.replace(/\s+/g, " ").slice(0, 100);
        }
        this.db
          .prepare(
            `INSERT INTO sessions(id,title,project,project_id,model,source_id,account_id,parent_id,relation,started_at,updated_at,turn_id,state,evidence,usage,total_tokens,uncertain,notes,pinned,state_at,state_observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,project=excluded.project,project_id=excluded.project_id,model=excluded.model,account_id=excluded.account_id,parent_id=excluded.parent_id,relation=excluded.relation,started_at=excluded.started_at,updated_at=excluded.updated_at,turn_id=excluded.turn_id,state=excluded.state,evidence=excluded.evidence,usage=excluded.usage,total_tokens=excluded.total_tokens,uncertain=excluded.uncertain,state_at=excluded.state_at,state_observed_at=excluded.state_observed_at`,
          )
          .run(
            id,
            title,
            meta?.data.projectLabel ?? "未知项目",
            first.projectId,
            model,
            first.sourceId,
            meta?.accountId ?? first.accountId,
            meta?.data.parentId ?? fallbackParent,
            meta?.data.relation ?? (fallbackParent ? "spawn" : null),
            first.occurredAt,
            metadataOnly
              ? (meta?.data.databaseUpdatedAt ?? last.occurredAt)
              : last.occurredAt,
            state.turnId,
            state.state,
            state.evidence,
            JSON.stringify(result.usage),
            result.usage.total,
            metadataOnly ? 2 : result.uncertain ? 1 : 0,
            old?.notes ?? "",
            old?.pinned ?? 0,
            state.at,
            state.observedAt ?? null,
          );
        this.db.prepare("DELETE FROM usage_points WHERE session_id=?").run(id);
        for (const p of result.points)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO usage_points VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              p.id,
              id,
              p.event.occurredAt,
              p.event.data.model ?? model,
              p.event.projectId,
              p.event.accountId,
              JSON.stringify(p.usage),
              JSON.stringify(p.event),
            );
        this.db
          .prepare("DELETE FROM pending_projection WHERE session_id=?")
          .run(id);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    this.dirty.clear();
  }
  effectiveAccount(r: any) {
    const b = this.db
      .prepare(
        "SELECT account_id FROM bindings WHERE source_id=? AND revoked=0 AND from_at<=? AND to_at>? ORDER BY from_at DESC LIMIT 1",
      )
      .get(r.source_id, r.started_at, r.started_at) as any;
    return b?.account_id ?? r.account_id ?? null;
  }
  session(r: any): Session {
    // A full source header proves session identity, not a measured zero. Keep
    // availability separate from metadataOnly; a real zero usage event counts.
    const usageAvailable =
      r.uncertain !== 2 &&
      !!this.db
        .prepare(
          "SELECT 1 FROM events WHERE session_id=? AND kind IN ('usage_response','usage_snapshot') LIMIT 1",
        )
        .get(r.id);
    return presentState(
      {
        id: r.id,
        title: r.title,
        project: r.project,
        model: r.model,
        sourceId: r.source_id,
        accountId: this.effectiveAccount(r),
        parentId: r.parent_id,
        relation: r.relation,
        startedAt: r.started_at,
        updatedAt: r.updated_at,
        stateOccurredAt: r.state_at,
        stateObservedAt: r.state_observed_at,
        turnId: r.turn_id,
        state: r.state,
        lastState: r.state,
        evidence: r.evidence,
        freshness: "stale",
        totalTokens: usageAvailable ? r.total_tokens : null,
        metadataOnly: r.uncertain === 2,
        usageAvailable,
        usageUncertain: r.uncertain === 1,
        pinned: !!r.pinned,
        notes: r.notes,
        jumpUrl: null,
      },
      Date.now(),
      this.getSetting<any>("preferences", {}).staleMs ?? 15000,
    );
  }
  sessions(params: URLSearchParams) {
    let where = "1=1";
    const args: any[] = [];
    for (const [param, col] of [
      ["model", "model"],
      ["source", "source_id"],
      ["project", "project_id"],
    ] as const) {
      const v = params.get(param);
      if (v) {
        where += ` AND ${col}=?`;
        args.push(v);
      }
    }
    const account = params.get("account");
    if (account) {
      const expr =
        "COALESCE((SELECT b.account_id FROM bindings b WHERE b.source_id=sessions.source_id AND b.revoked=0 AND b.from_at<=sessions.started_at AND b.to_at>sessions.started_at ORDER BY b.from_at DESC LIMIT 1),account_id)";
      where +=
        account === "unknown"
          ? " AND " + expr + " IS NULL"
          : " AND " + expr + "=?";
      if (account !== "unknown") args.push(account);
    }
    const q = params.get("q");
    if (q) {
      where +=
        " AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
      const safe = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      args.push(safe, safe, safe);
    }
    for (const [param, op] of [
      ["from", ">="],
      ["to", "<="],
    ]) {
      const v = params.get(param);
      if (v) {
        where += ` AND updated_at${op}?`;
        args.push(v);
      }
    }
    const state = params.get("status");
    if (state) {
      if (state === "unknown") {
        where += ` AND (state='unknown' OR (state NOT IN ('completed','failed','cancelled') AND (COALESCE(state_at,updated_at)<=? OR COALESCE(state_at,updated_at)>?)))`;
        args.push(
          new Date(
            Date.now() -
              (this.getSetting<any>("preferences", {}).staleMs ?? 15000),
          ).toISOString(),
          new Date(Date.now() + 1000).toISOString(),
        );
      } else {
        where += " AND state=?";
        args.push(state);
        if (!["completed", "failed", "cancelled"].includes(state)) {
          where +=
            " AND COALESCE(state_at,updated_at)>? AND COALESCE(state_at,updated_at)<=?";
          args.push(
            new Date(
              Date.now() -
                (this.getSetting<any>("preferences", {}).staleMs ?? 15000),
            ).toISOString(),
            new Date(Date.now() + 1000).toISOString(),
          );
        }
      }
    }
    const page = Math.max(
      1,
      Math.min(1000000, Number(params.get("page")) || 1),
    );
    const pageSize = Math.max(
      1,
      Math.min(200, Number(params.get("pageSize")) || 50),
    );
    const total = (
      this.db
        .prepare(`SELECT count(*) n FROM sessions WHERE ${where}`)
        .get(...args) as any
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${where} ORDER BY pinned DESC,updated_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize);
    return { items: rows.map((r) => this.session(r)), total, page, pageSize };
  }
  detail(id: string, before?: string | null) {
    const r = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as any;
    if (!r) return null;
    const agents = this.db
      .prepare(
        `WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN family f ON s.parent_id=f.id WHERE s.relation='spawn') SELECT s.* FROM sessions s JOIN family f ON s.id=f.id LIMIT 1000`,
      )
      .all(id)
      .map((x) => this.session(x));
    let cursor: { at: string; id: string; watermark: number } | null = null;
    if (before?.startsWith("ev1:")) {
      cursor = decodeCursor(before.slice(4));
      if (
        !cursor ||
        typeof cursor.at !== "string" ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        typeof cursor.id !== "string" ||
        !Number.isSafeInteger(cursor.watermark)
      )
        throw Error("无效事件游标");
    }
    const watermark =
      cursor?.watermark ??
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(rowid),0) n FROM events WHERE session_id=?",
          )
          .get(id) as any
      ).n;
    const rows = this.db
      .prepare(
        "SELECT id,occurred_at,json FROM events WHERE session_id=? AND rowid<=? AND (occurred_at<? OR (occurred_at=? AND id<?)) ORDER BY occurred_at DESC,id DESC LIMIT 201",
      )
      .all(
        id,
        watermark,
        cursor?.at ?? before ?? "9999",
        cursor?.at ?? before ?? "9999",
        cursor?.id ?? "",
      ) as any[];
    const page = rows.slice(0, 200),
      last = page.at(-1);
    const nextBefore =
      rows.length > 200 && last
        ? "ev1:" +
          encodeCursor({ at: last.occurred_at, id: last.id, watermark })
        : null;
    const events = page.map((x) => JSON.parse(x.json)).reverse();
    const session = this.session(r);
    return {
      session,
      agents,
      events,
      nextBefore,
      usage: session.usageAvailable ? JSON.parse(r.usage) : null,
      notes: r.notes,
      pinned: !!r.pinned,
      usageUncertain: !!r.uncertain,
    };
  }
  usage(params = new URLSearchParams()) {
    const rows = this.db
      .prepare(
        "SELECT u.usage,u.model,s.project,substr(u.occurred_at,1,10) day FROM usage_points u JOIN sessions s ON s.id=u.session_id WHERE u.occurred_at>=? AND u.occurred_at<=?",
      )
      .all(params.get("from") ?? "", params.get("to") ?? "9999") as any[];
    const days = new Map<string, Usage>(),
      models = new Map<string, number>(),
      projects = new Map<string, number>();
    for (const r of rows) {
      const u = JSON.parse(r.usage) as Usage;
      const day = days.get(r.day) ?? zeroUsage();
      for (const k of Object.keys(day) as (keyof Usage)[]) day[k] += u[k];
      days.set(r.day, day);
      models.set(r.model, (models.get(r.model) ?? 0) + u.total);
      projects.set(r.project, (projects.get(r.project) ?? 0) + u.total);
    }
    return {
      days: [...days]
        .map(([date, u]) => ({ date, ...u }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      models: [...models].map(([model, total]) => ({ model, total })),
      projects: [...projects].map(([project, total]) => ({ project, total })),
      quotas: this.quotas(),
      quotaHistory: (
        this.db
          .prepare(
            "SELECT json FROM quotas ORDER BY observed_at DESC LIMIT 200",
          )
          .all() as any[]
      ).map((r) => ({ ...JSON.parse(r.json), freshness: "historical" })),
      officialUsage: (
        this.db
          .prepare(
            "SELECT value FROM settings WHERE key LIKE 'officialUsage:%' ORDER BY json_extract(value,'$.observedAt') DESC LIMIT 10",
          )
          .all() as any[]
      ).map((r) => JSON.parse(r.value)),
      attribution:
        "UTC response event date; input includes cached and output includes reasoning",
      usageUncertain: !!this.db
        .prepare("SELECT 1 FROM sessions WHERE uncertain=1 LIMIT 1")
        .get(),
    };
  }
  overview() {
    const rows = this.db.prepare("SELECT * FROM sessions").all() as any[];
    const usage = zeroUsage(),
      states: Record<string, number> = {};
    for (const r of rows) {
      const u = JSON.parse(r.usage);
      for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u[k];
      const s = this.session(r);
      states[s.state] = (states[s.state] ?? 0) + 1;
    }
    const sessions = rows.map((r) => this.session(r));
    const day = new Date().toISOString().slice(0, 10);
    const active = sessions.filter(
      (s) =>
        ["running", "waiting_user", "waiting_approval"].includes(s.state) ||
        (s.state === "failed" && s.updatedAt >= day),
    );
    const selected = new Set(active.map((s) => s.id)),
      byId = new Map(sessions.map((s) => [s.id, s]));
    for (const s of active) {
      let parent = s.parentId,
        seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const p = byId.get(parent);
        if (!p) break;
        selected.add(parent);
        parent = p.parentId;
      }
    }
    const activity = {
      items: sessions.filter((s) => selected.has(s.id)).slice(0, 1000),
      mainCount: active.filter((s) => s.relation !== "spawn").length,
      childCount: active.filter((s) => s.relation === "spawn").length,
      waitingCount: active.filter(
        (s) => s.state === "waiting_user" || s.state === "waiting_approval",
      ).length,
      failedCount: active.filter((s) => s.state === "failed").length,
      unknownCount: sessions.filter((s) => s.state === "unknown").length,
      total: active.length,
      truncated: selected.size > 1000,
    };
    const todayUsage =
      this.usage(
        new URLSearchParams({
          from: day + "T00:00:00.000Z",
          to: day + "T23:59:59.999Z",
        }),
      ).days[0] ?? zeroUsage();
    return {
      activity,
      todayUsage,
      recentCompleted: sessions
        .filter((s) => s.state === "completed")
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
        )
        .slice(0, 5),
      usageUncertain: rows.some((r) => r.uncertain === 1),
      sessions: rows.length,
      events: (this.db.prepare("SELECT count(*) n FROM events").get() as any).n,
      usage,
      states,
      activeEvidence: {
        confirmed: rows.filter(
          (r) =>
            this.session(r).state === "running" && r.evidence === "confirmed",
        ).length,
        inferred: rows.filter(
          (r) =>
            this.session(r).state === "running" && r.evidence === "inferred",
        ).length,
        unknown: states.unknown ?? 0,
      },
      quotas: this.quotas(),
      sources: this.sources(),
      limitations: [
        "历史日志证明事件发生，不保证完整旁观桌面实时状态。静默显示未知，不判定完成。",
        "用量趋势按响应事件 UTC 日期统计；不等同官方账号账单。",
        "fork 边界不明的用量不计入汇总；尚无可靠每任务额度归因。",
        "中心同步仅含经授权元数据，不含完整对话。",
      ],
    };
  }
  deleteSession(id: string) {
    this.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO tombstones VALUES(?,?)")
        .run(id, new Date().toISOString());
      this.db
        .prepare(
          "DELETE FROM outbox WHERE event_id IN (SELECT id FROM events WHERE session_id=?) OR event_id IN (SELECT id FROM usage_points WHERE session_id=?)",
        )
        .run(id, id);
      this.db.prepare("DELETE FROM usage_points WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM events WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.db.prepare("DELETE FROM annotations WHERE session_id=?").run(id);
      this.db
        .prepare("DELETE FROM pending_projection WHERE session_id=?")
        .run(id);
      this.audit("delete-monitor-session", id);
    });
  }
  createBinding(v: any) {
    if (
      !v.accountId ||
      !v.sourceId ||
      !v.from ||
      !v.to ||
      !Number.isFinite(Date.parse(v.from)) ||
      !Number.isFinite(Date.parse(v.to)) ||
      Date.parse(v.from) >= Date.parse(v.to)
    )
      throw Error("需要有效账号、来源与不重叠的时间范围");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM bindings WHERE source_id=? AND revoked=0 AND from_at<? AND to_at>?",
        )
        .get(
          v.sourceId,
          new Date(v.to).toISOString(),
          new Date(v.from).toISOString(),
        )
    )
      throw Error("绑定时间范围重叠");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO bindings VALUES(?,?,?,?,?,?,0)")
      .run(
        id,
        v.accountId,
        v.sourceId,
        new Date(v.from).toISOString(),
        new Date(v.to).toISOString(),
        "manual",
      );
    this.audit("bind-account", id);
    return id;
  }
  accounts() {
    return {
      // Unbound probe IDs are observations, not user-created account identities.
      accounts: this.db
        .prepare(
          "SELECT id,label,provider FROM accounts WHERE evidence!='account_rpc_unbound'",
        )
        .all(),
      bindings: (this.db.prepare("SELECT * FROM bindings").all() as any[]).map(
        (b) => ({
          id: b.id,
          accountId: b.account_id,
          sourceId: b.source_id,
          from: b.from_at,
          to: b.to_at,
          evidence: b.evidence,
          revoked: !!b.revoked,
        }),
      ),
      devices: [{ id: this.getSetting("deviceId", "unknown"), label: "本机" }],
      environments: [
        {
          id: this.getSetting("environmentId", "unknown"),
          kind: process.platform === "win32" ? "windows-native" : "native",
          label: process.platform,
        },
      ],
    };
  }
  /** Caller must pause collection/sync. No raw events or sync identity/queues are reset. */
  async recomputeDerived(options: { backup?: boolean; force?: boolean } = {}) {
    const version = 5;
    if (
      !options.force &&
      this.getSetting("derivedProjectionVersion", 0) >= version
    )
      return {
        skipped: true,
        sessions: 0,
        backup: null as string | null,
        version,
      };
    const saved = options.backup === false ? null : await this.backup();
    const repair = this.getSetting<{
      version: number;
      priorRebuilding: boolean;
    } | null>("derivedProjectionRepair", null);
    const priorRebuilding =
      repair && repair.version <= version
        ? repair.priorRebuilding
        : this.getSetting("indexRebuilding", false);
    this.transaction(() => {
      this.setSetting("derivedProjectionRepair", { version, priorRebuilding });
      this.setSetting("indexRebuilding", true);
      this.db.exec(
        "INSERT OR IGNORE INTO pending_projection SELECT DISTINCT session_id FROM events WHERE session_id NOT IN (SELECT session_id FROM tombstones)",
      );
    });
    const count = (
      this.db.prepare("SELECT count(*) n FROM pending_projection").get() as any
    ).n as number;
    // A failure leaves the durable queue and upload pause in place for a safe retry.
    this.projectDirty();
    this.transaction(() => {
      this.setSetting("derivedProjectionVersion", version);
      this.setSetting("indexRebuilding", priorRebuilding);
      this.db
        .prepare("DELETE FROM settings WHERE key='derivedProjectionRepair'")
        .run();
      this.audit("recompute-derived-v5", String(count));
    });
    return { skipped: false, sessions: count, backup: saved, version };
  }
  resetIndex() {
    this.transaction(() => {
      this.db.exec(
        "INSERT INTO annotations SELECT id,notes,pinned FROM sessions WHERE true ON CONFLICT(session_id) DO UPDATE SET notes=excluded.notes,pinned=excluded.pinned; DELETE FROM events;DELETE FROM usage_points;DELETE FROM sessions;DELETE FROM cursors;DELETE FROM pending_projection;DELETE FROM outbox WHERE acked=0;",
      );
      this.dirty.clear();
      this.audit("rebuild-index", "preserved-annotations-bindings-tombstones");
    });
  }
  async backup() {
    const dir = path.join(this.dir, "backups");
    mkdirSync(dir, { recursive: true });
    const name = "monitor-" + Date.now() + ".sqlite";
    await backup(this.db, path.join(dir, name));
    this.audit("backup", name);
    return name;
  }
  diskBytes() {
    return ["", "-wal", "-shm"].reduce(
      (n, s) =>
        n + (existsSync(this.file + s) ? statSync(this.file + s).size : 0),
      0,
    );
  }
  close() {
    this.db.close();
  }
}
