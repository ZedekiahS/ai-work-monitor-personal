import { Store } from "../core/store.js";
import { hash, Event } from "../core/model.js";
import {
  withinGrant,
  previewFields,
  parseEvent,
  id as wireId,
  Grant,
  WireEvent,
} from "@ai-work-monitor/sync-protocol";
interface Pair {
  name?: string;
  kind?: string;
  url: string;
  deviceToken: string;
  deviceId: string;
  workspaceId: string;
  userId: string;
  protocolVersion: number;
}
interface Connection extends Pair {
  id: string;
}
abstract class SyncBase {
  running = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  failures = 0;
  status = "未连接";
  stopped = false;
  protected uploadController = new AbortController();
  constructor(public store: Store) {}
  pairInfo() {
    return this.store.getSetting<Pair | null>("hubPair", null);
  }
  async request(
    route: string,
    method = "GET",
    body?: any,
    pair = this.pairInfo(),
  ) {
    if (!pair) throw Error("尚未配对中心");
    const response = await fetch(pair.url + route, {
      method,
      headers: {
        Authorization: "Bearer " + pair.deviceToken,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(10000),
        this.uploadController.signal,
      ]),
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        this.status = "设备凭据已撤销或授权不可用";
      throw Error("中心请求失败 HTTP " + response.status);
    }
    return response.json() as Promise<any>;
  }
  async pair(v: any) {
    const url = new URL(v.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error("中心地址只允许协议、主机和端口");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw Error("远程中心必须使用 HTTPS");
    const base = url.origin;
    const res = await fetch(base + "/v1/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: v.code,
        label: "AI Work Monitor 本机",
        deviceId: this.store.getSetting("deviceId", ""),
        environmentId: this.store.getSetting("environmentId", ""),
      }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!res.ok) throw Error(res.status===409 ? "此配对链接缺少签发信息，请在已登录的电脑重新生成" : "配对失败 HTTP " + res.status);
    const data = (await res.json()) as Pair;
    this.store.setSetting("hubPair", { ...data, url: base });
    this.store.audit("pair-device", data.deviceId);
    this.status = "已连接；等待选择授权";
    return { ok: true, workspaceId: data.workspaceId };
  }
  grants() {
    return (
      this.store.db.prepare("SELECT json,revoked FROM grants").all() as any[]
    ).map((r) => ({ ...JSON.parse(r.json), revoked: !!r.revoked }));
  }
  preview() {
    return {
      grants: this.grants(),
      pendingRevocations: this.store.getSetting<string[]>(
        "pendingRevocations",
        [],
      ),
      pendingErases: this.store.getSetting<string[]>("pendingErases", []),
      previewFields,
      mode: "metadata-only",
      pair: this.pairInfo()
        ? {
            kind: this.pairInfo()!.kind,
            url: this.pairInfo()!.url,
            workspaceId: this.pairInfo()!.workspaceId,
          }
        : null,
      status: this.status,
      projects: this.store.db
        .prepare(
          "SELECT DISTINCT project_id id,project label FROM sessions ORDER BY project",
        )
        .all(),
    };
  }
  async grant(v: any) {
    const pair = this.pairInfo();
    if (!pair) throw Error("请先配对中心");
    const g = await this.request("/v1/grants", "POST", {
      workspaceId: pair.workspaceId,
      accountIds: v.accountIds,
      projectIds: v.projectIds,
      from: v.from,
      to: v.to,
      shareQuota: !!v.shareQuota,
      retentionDays: v.retentionDays ?? 90,
    });
    this.store.db
      .prepare("INSERT INTO grants VALUES(?,?,0)")
      .run(g.id, JSON.stringify(g));
    this.store.audit("share-grant", g.id);
    return g;
  }
  async revoke(id: string) {
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE grants SET revoked=1 WHERE id=?").run(id);
      this.store.db.prepare("DELETE FROM outbox WHERE grant_id=?").run(id);
      const pending = this.store.getSetting<string[]>("pendingRevocations", []);
      this.store.setSetting("pendingRevocations", [
        ...new Set([...pending, id]),
      ]);
      this.store.audit("withdraw-sharing", id);
    });
    try {
      await this.flushRevocations();
      return { ok: true, purged: true };
    } catch {
      return {
        ok: true,
        purged: false,
        pending: true,
        message: "本机已停止发送；中心删除待网络恢复",
      };
    }
  }
  async erase(sessionId: string) {
    const pending = this.store.getSetting<string[]>("pendingErases", []);
    this.store.setSetting("pendingErases", [
      ...new Set([...pending, sessionId]),
    ]);
    if (this.pairInfo())
      try {
        await this.flushRevocations();
      } catch {}
  }
  async flushRevocations() {
    for (const id of this.store.getSetting<string[]>(
      "pendingRevocations",
      [],
    )) {
      await this.request("/v1/grants/" + encodeURIComponent(id), "DELETE");
      this.store.setSetting(
        "pendingRevocations",
        this.store
          .getSetting<string[]>("pendingRevocations", [])
          .filter((x) => x !== id),
      );
    }
    const pair = this.pairInfo();
    if (pair)
      for (const sessionId of this.store.getSetting<string[]>(
        "pendingErases",
        [],
      )) {
        await this.request("/v1/erase", "POST", {
          workspaceId: pair.workspaceId,
          sessionId,
        });
        this.store.setSetting(
          "pendingErases",
          this.store
            .getSetting<string[]>("pendingErases", [])
            .filter((x) => x !== sessionId),
        );
      }
  }
  abstract enqueue(): void;
  wire(e: Event, g: Grant, id: string): WireEvent | null {
    const row = this.store.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(e.sessionId) as any;
    const creatorOnly = [
      "session_creator_only",
      "database_creator_account_id",
      "session_header", // Older parser cache also described creator identity.
    ].includes(e.data.accountEvidence);
    const manual = this.store.db
      .prepare(
        "SELECT account_id FROM bindings WHERE source_id=? AND revoked=0 AND evidence='manual' AND from_at<=? AND to_at>? ORDER BY from_at DESC LIMIT 1",
      )
      .get(e.sourceId, e.occurredAt, e.occurredAt) as
      | { account_id: string }
      | undefined;
    // A session creator is not proof of this turn's billing account. Do not fall
    // back to sessions.account_id, including after a later account switch.
    const accountId = creatorOnly
      ? manual?.account_id
      : (e.accountId ?? manual?.account_id);
    if (!accountId) return null;
    return {
      seq: 1,
      eventId: id,
      grantId: g.id,
      provider: e.provider,
      sourceId: e.sourceId,
      environmentId: e.environmentId,
      sessionId: e.sessionId,
      turnId: e.turnId,
      agentId: e.agentId,
      parentId: row?.parent_id ?? null,
      relation: row?.relation ?? null,
      accountId,
      projectId: e.projectId,
      projectAlias:
        (g as Grant & { projectAliases?: Record<string, string> })
          .projectAliases?.[e.projectId] ?? "项目 " + e.projectId.slice(-6),
      kind: e.kind,
      occurredAt: e.occurredAt,
      observedAt: e.observedAt,
      model: (() => {
        try {
          return wireId(e.data.model);
        } catch {
          return null;
        }
      })(),
      state:
        (
          {
            turn_started: "running",
            turn_completed: "completed",
            turn_failed: "failed",
            turn_cancelled: "cancelled",
            waiting_user: "waiting_user",
            waiting_approval: "waiting_approval",
          } as Record<string, string>
        )[e.kind] ?? null,
      evidence: manual || row?.uncertain ? "inferred" : e.evidence,
    };
  }
  queue(w: WireEvent, g: Grant) {
    if (withinGrant(w, g)) return;
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(event_id,grant_id,json) VALUES(?,?,?)",
      )
      .run(w.eventId, g.id, JSON.stringify(w));
  }
  abstract once(force?: boolean): Promise<void>;
  start() {
    this.stopped = false;
    if (this.uploadController.signal.aborted)
      this.uploadController = new AbortController();
    const tick = async () => {
      await this.once(false);
      if (!this.stopped)
        this.timer = setTimeout(
          tick,
          Math.min(300000, 30000 * 2 ** Math.min(this.failures, 4)) +
            Math.floor(Math.random() * 5000),
        );
    };
    void tick();
  }
  stop() {
    this.stopped = true;
    this.uploadController.abort();
    clearTimeout(this.timer);
  }
}

const delta = (v: any) => ({
  input: Number(v?.input ?? 0),
  cached: Number(v?.cached ?? 0),
  output: Number(v?.output ?? 0),
  reasoning: Number(v?.reasoning ?? 0),
});
const sameDelta = (a: any, b: any) =>
  JSON.stringify(delta(a)) === JSON.stringify(delta(b));
export class SyncClient extends SyncBase {
  selectionRevision() {
    return this.store.getSetting<number>("activeHubSelectionRevision", 0);
  }
  addConnection(
    data: Pair,
    expectedSelectionRevision = this.selectionRevision(),
  ) {
    const connection: Connection = {
      ...data,
      id: "connection:" + hash(data.url + data.workspaceId + data.deviceId),
    };
    this.store.setSetting("hubPairs", [
      ...this.connections().filter((c) => c.id !== connection.id),
      connection,
    ]);
    // Registering may finish after the user selects a different receiver. Save
    // the successful connection without replacing that later choice, even if
    // the user has since returned to the same connection (A -> B -> A).
    if (this.selectionRevision() === expectedSelectionRevision)
      this.selectPair(connection.id);
    return connection;
  }
  updateCredential(id: string, token: string) {
    this.store.setSetting(
      "hubPairs",
      this.connections().map((c) =>
        c.id === id ? { ...c, deviceToken: token } : c,
      ),
    );
    if (this.pairInfo()?.id === id)
      this.store.setSetting("hubPair", this.pairInfo());
  }
  pause(id: string, paused: boolean) {
    const row = this.store.db
      .prepare("SELECT json FROM grants WHERE id=? AND revoked=0")
      .get(id) as any;
    if (!row) throw Error("授权不存在");
    this.uploadController.abort();
    this.uploadController = new AbortController();
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE grants SET json=? WHERE id=?")
        .run(JSON.stringify({ ...JSON.parse(row.json), paused }), id);
      this.store.db
        .prepare("DELETE FROM outbox WHERE grant_id=? AND acked=0")
        .run(id);
    });
    if (paused) {
      const connection = this.connections().find(
        (c) => c.id === JSON.parse(row.json).connectionId,
      );
      if (connection)
        void this.request(
          "/v1/heartbeat",
          "POST",
          this.heartbeat(connection),
          connection,
        ).catch(() => {});
    }
    return { ok: true, paused };
  }
  constructor(store: Store) {
    super(store);
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS sync_point_state(grant_id TEXT NOT NULL,event_id TEXT NOT NULL,session_id TEXT NOT NULL,last_usage TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,base_json TEXT NOT NULL,PRIMARY KEY(grant_id,event_id));
 CREATE TABLE IF NOT EXISTS sync_attempts(seq INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS sync_erased(session_id TEXT PRIMARY KEY,completed_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sync_erased_targets(connection_id TEXT NOT NULL,session_id TEXT NOT NULL,completed_at TEXT NOT NULL,PRIMARY KEY(connection_id,session_id));
 CREATE TABLE IF NOT EXISTS sync_blocked(grant_id TEXT NOT NULL,session_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(grant_id,session_id));
 CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(acked,seq);`);
    const legacy = store.getSetting<Pair | null>("hubPair", null);
    if (!this.connections().length && legacy) {
      const c = {
        ...legacy,
        id:
          "connection:" +
          hash(legacy.url + legacy.workspaceId + legacy.deviceId),
      };
      store.setSetting("hubPairs", [c]);
      store.setSetting("activeHubPair", c.id);
    }
    const fallback = this.pairInfo();
    for (const row of store.db
      .prepare("SELECT id,json FROM grants")
      .all() as any[]) {
      const g = JSON.parse(row.json);
      if (!g.connectionId && fallback && g.workspaceId === fallback.workspaceId)
        store.db
          .prepare("UPDATE grants SET json=? WHERE id=?")
          .run(JSON.stringify({ ...g, connectionId: fallback.id }), row.id);
    }
    const rejected = new Set(
      store.getSetting<any[]>("syncRejected", []).map((r) => r.seq),
    );
    for (const row of store.db
      .prepare(
        "SELECT * FROM outbox WHERE acked=1 AND json_extract(json,'$.kind')='usage'",
      )
      .all() as any[]) {
      if (!rejected.has(row.seq)) this.recordPoint(JSON.parse(row.json));
    }
  }
  connections() {
    return this.store.getSetting<Connection[]>("hubPairs", []);
  }
  override pairInfo() {
    const c = this.connections(),
      active = this.store.getSetting<string | null>("activeHubPair", null);
    return c.find((x) => x.id === active) ?? c[0] ?? null;
  }
  requireConnection(connectionId: string) {
    const pair = this.pairInfo();
    if (!connectionId || !pair || pair.id !== connectionId)
      throw Error("接收方已改变，请重新确认共享目标");
    return pair;
  }
  selectPair(id: string) {
    const pair = this.connections().find((c) => c.id === id);
    if (!pair) throw Error("目标连接不存在");
    this.store.setSetting(
      "activeHubSelectionRevision",
      this.selectionRevision() + 1,
    );
    this.store.setSetting("activeHubPair", id);
    this.store.setSetting("hubPair", pair);
    return {
      ok: true,
      connection: {
        id: pair.id,
        url: pair.url,
        workspaceId: pair.workspaceId,
        active: true,
      },
    };
  }
  override async pair(
    v: any,
    expectedSelectionRevision = this.selectionRevision(),
  ) {
    const url = new URL(v.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error("中心地址只允许协议、主机和端口");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw Error("远程中心必须使用 HTTPS");
    const base = url.origin;
    const res = await fetch(base + "/v1/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: v.code,
        label: "AI Work Monitor 本机",
        deviceId: this.store.getSetting("deviceId", ""),
        environmentId: this.store.getSetting("environmentId", ""),
      }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!res.ok) throw Error(res.status===409 ? "此配对链接缺少签发信息，请在已登录的电脑重新生成" : "配对失败 HTTP " + res.status);
    const data = (await res.json()) as Pair;
    if (
      data.protocolVersion !== 1 ||
      !data.deviceToken ||
      !data.workspaceId ||
      !data.deviceId
    )
      throw Error("中心配对返回格式不兼容");
    const connection = this.addConnection(
      { ...data, name: v.name, url: base },
      expectedSelectionRevision,
    );
    this.store.audit("pair-device", data.deviceId);
    this.status = "已连接；等待选择授权";
    return {
      ok: true,
      workspaceId: data.workspaceId,
      connectionId: connection.id,
    };
  }
  override async grant(v: any) {
    const pair = this.requireConnection(v.connectionId);
    const g = await this.request(
      "/v1/grants",
      "POST",
      {
        workspaceId: pair.workspaceId,
        accountIds: v.accountIds,
        projectIds: v.projectIds,
        from: v.from,
        to: v.to,
        shareQuota: !!v.shareQuota,
        retentionDays: v.retentionDays ?? 90,
      },
      pair,
    );
    const projectAliases = Object.fromEntries(
      (v.projectIds as string[]).map((id) => [
        id,
        typeof v.projectAliases?.[id] === "string" &&
        /^[^\\/<>\x00-\x1f]{1,80}$/.test(v.projectAliases[id])
          ? v.projectAliases[id]
          : "项目 " + id.slice(-6),
      ]),
    );
    const bound = { ...g, connectionId: pair.id, projectAliases };
    this.store.db
      .prepare("INSERT INTO grants VALUES(?,?,0)")
      .run(g.id, JSON.stringify(bound));
    this.store.audit("share-grant", g.id);
    return bound;
  }
  override async revoke(id: string) {
    if (!this.grants().some((g) => g.id === id)) throw Error("授权不存在");
    this.uploadController.abort();
    this.uploadController = new AbortController();
    return super.revoke(id);
  }
  override preview() {
    const states = this.store.getSetting<Record<string, any>>(
        "hubConnectionStates",
        {},
      ),
      active = this.pairInfo()?.id;
    return {
      ...super.preview(),
      pair: this.pairInfo()
        ? {
            id: this.pairInfo()!.id,
            name: this.pairInfo()!.name,
            userId: this.pairInfo()!.userId,
            kind: this.pairInfo()!.kind,
            url: this.pairInfo()!.url,
            workspaceId: this.pairInfo()!.workspaceId,
          }
        : null,
      connections: this.connections().map((c) => ({
        id: c.id,
        url: c.url,
        name: c.name,
        kind: c.kind,
        workspaceId: c.workspaceId,
        userId: c.userId,
        active: c.id === active,
        status: states[c.id]?.status ?? "等待首次同步",
        lastSyncAt: states[c.id]?.lastSyncAt ?? null,
      })),
      blocked: this.store.db
        .prepare(
          "SELECT grant_id AS grantId,session_id AS sessionId,reason,created_at AS createdAt FROM sync_blocked",
        )
        .all(),
    };
  }
  override async erase(sessionId: string) {
    this.store.db
      .prepare("DELETE FROM outbox WHERE json_extract(json,'$.sessionId')=?")
      .run(sessionId);
    await super.erase(sessionId);
  }
  override async flushRevocations(connectionId?: string) {
    const targets = connectionId
      ? this.connections().filter((c) => c.id === connectionId)
      : this.connections();
    let failed = false;
    for (const c of targets) {
      try {
        for (const gid of this.store.getSetting<string[]>(
          "pendingRevocations",
          [],
        )) {
          const g = this.grants().find((g) => g.id === gid);
          if (!g || g.connectionId !== c.id) continue;
          await this.request(
            "/v1/grants/" + encodeURIComponent(gid),
            "DELETE",
            undefined,
            c,
          );
          this.store.setSetting(
            "pendingRevocations",
            this.store
              .getSetting<string[]>("pendingRevocations", [])
              .filter((x) => x !== gid),
          );
        }
        for (const sessionId of this.store.getSetting<string[]>(
          "pendingErases",
          [],
        )) {
          if (
            this.store.db
              .prepare(
                "SELECT 1 FROM sync_erased_targets WHERE connection_id=? AND session_id=?",
              )
              .get(c.id, sessionId)
          )
            continue;
          await this.request(
            "/v1/erase",
            "POST",
            { workspaceId: c.workspaceId, sessionId },
            c,
          );
          this.store.db
            .prepare("INSERT OR REPLACE INTO sync_erased_targets VALUES(?,?,?)")
            .run(c.id, sessionId, new Date().toISOString());
        }
      } catch {
        failed = true;
      }
    }
    this.store.setSetting(
      "pendingErases",
      this.store
        .getSetting<string[]>("pendingErases", [])
        .filter((sid) =>
          this.connections().some(
            (c) =>
              !this.store.db
                .prepare(
                  "SELECT 1 FROM sync_erased_targets WHERE connection_id=? AND session_id=?",
                )
                .get(c.id, sid),
          ),
        ),
    );
    if (failed) throw Error("部分目标撤回或删除尚待网络恢复");
  }
  override queue(w: WireEvent, g: Grant) {
    const scopeError = withinGrant(w, g);
    if (scopeError) {
      if (scopeError === "future_clock") this.block(g, w, scopeError);
      return;
    }
    try {
      parseEvent(w);
    } catch {
      this.block(g, w, "wire_schema_incompatible");
      return;
    }
    super.queue(w, g);
  }
  private block(g: Grant, w: WireEvent, reason: string) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO sync_blocked VALUES(?,?,?,?)")
      .run(g.id, w.sessionId ?? "@quota", reason, new Date().toISOString());
    this.store.audit("sync-blocked:" + reason, w.sessionId ?? g.id);
  }
  private recordPoint(w: WireEvent) {
    if (w.kind !== "usage" || !w.usage || !w.sessionId) return;
    this.store.db
      .prepare("INSERT OR IGNORE INTO sync_point_state VALUES(?,?,?,?,0,?)")
      .run(
        w.grantId,
        w.eventId,
        w.sessionId,
        JSON.stringify(delta(w.usage)),
        JSON.stringify(w),
      );
  }
  private reconcile(g: Grant): Set<string> {
    const waiting = new Set<string>();
    this.store.db
      .prepare(
        "DELETE FROM outbox WHERE json_extract(json,'$.sessionId') IN (SELECT session_id FROM tombstones)",
      )
      .run();
    const pending = this.store.db
      .prepare("SELECT * FROM outbox WHERE grant_id=? AND acked=0")
      .all(g.id) as any[];
    for (const row of pending) {
      const w = JSON.parse(row.json) as WireEvent;
      if (w.sessionId) {
        const pointEvent = this.store.db
          .prepare("SELECT event_json FROM usage_points WHERE id=?")
          .get(w.correctsEventId ?? w.eventId) as
          | { event_json: string }
          | undefined;
        const eventRows = pointEvent
          ? [{ json: pointEvent.event_json }]
          : (this.store.db
              .prepare(
                "SELECT json FROM events WHERE session_id=? AND source_id=? AND occurred_at=? LIMIT 20",
              )
              .all(w.sessionId, w.sourceId, w.occurredAt) as {
              json: string;
            }[]);
        if (
          eventRows.some((row) => {
            const proof = this.wire(JSON.parse(row.json), g, w.eventId);
            return !proof || proof.accountId !== w.accountId;
          })
        ) {
          this.block(g, w, "account_attribution_unconfirmed_or_changed");
          continue;
        }
      }
      if (w.kind === "usage_correction") {
        if (w.sessionId) waiting.add(w.sessionId);
        continue;
      }
      if (w.kind !== "usage") continue;
      const point = this.store.db
        .prepare("SELECT usage FROM usage_points WHERE id=?")
        .get(w.eventId) as any;
      const current = delta(point ? JSON.parse(point.usage) : null);
      if (sameDelta(w.usage, current)) continue;
      if (
        !this.store.db
          .prepare("SELECT 1 FROM sync_attempts WHERE seq=?")
          .get(row.seq)
      ) {
        w.usage = current;
        this.store.db
          .prepare("UPDATE outbox SET json=? WHERE seq=? AND acked=0")
          .run(JSON.stringify(w), row.seq);
      } else if (w.sessionId) waiting.add(w.sessionId);
    }
    const points = this.store.db
      .prepare(
        `SELECT s.*,u.usage AS current_usage,u.event_json FROM sync_point_state s LEFT JOIN usage_points u ON u.id=s.event_id WHERE s.grant_id=? AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM sync_blocked b WHERE b.grant_id=s.grant_id AND b.session_id=s.session_id) AND (u.id IS NULL OR json_extract(u.event_json,'$.data.accountEvidence') IN ('session_creator_only','database_creator_account_id','session_header') OR json_extract(u.event_json,'$.accountId') IS NULL OR json_extract(u.event_json,'$.accountId')!=json_extract(s.base_json,'$.accountId') OR u.project_id!=json_extract(s.base_json,'$.projectId') OR json_extract(s.last_usage,'$.input')!=json_extract(u.usage,'$.input') OR json_extract(s.last_usage,'$.cached')!=json_extract(u.usage,'$.cached') OR json_extract(s.last_usage,'$.output')!=json_extract(u.usage,'$.output') OR json_extract(s.last_usage,'$.reasoning')!=json_extract(u.usage,'$.reasoning'))`,
      )
      .all(g.id) as any[];
    for (const point of points) {
      if (waiting.has(point.session_id)) continue;
      const base = JSON.parse(point.base_json) as WireEvent;
      const target = delta(
        point.current_usage ? JSON.parse(point.current_usage) : null,
      );
      if (point.event_json) {
        const current = this.wire(
          JSON.parse(point.event_json),
          g,
          base.eventId,
        );
        if (
          !current ||
          current.accountId !== base.accountId ||
          current.projectId !== base.projectId
        ) {
          this.block(g, base, "attribution_changed_requires_withdrawal");
          continue;
        }
      }
      if (sameDelta(JSON.parse(point.last_usage), target)) continue;
      const w: WireEvent = {
        ...base,
        eventId:
          "correction:" +
          hash(
            base.eventId + String(point.revision + 1) + JSON.stringify(target),
          ),
        kind: "usage_correction",
        correctsEventId: base.eventId,
        expectedRevision: point.revision,
        revision: point.revision + 1,
        usage: target,
        observedAt: new Date().toISOString(),
      };
      const reason = withinGrant(w, g);
      if (reason) {
        this.block(g, w, "correction_" + reason);
        continue;
      }
      this.queue(w, g);
      waiting.add(point.session_id);
    }
    return waiting;
  }
  override enqueue(connectionId?: string) {
    const inactive = this.store.getSetting<string[]>(
      "inactiveQuotaSources",
      [],
    );
    for (const row of this.store.db
      .prepare(
        "SELECT o.json,g.json AS grant_json FROM outbox o JOIN grants g ON g.id=o.grant_id WHERE json_extract(o.json,'$.kind')='quota'",
      )
      .all() as any[]) {
      const w = JSON.parse(row.json);
      if (inactive.includes(w.sourceId)) {
        const g = JSON.parse(row.grant_json);
        this.block(g, w, "quota_source_changed_confirmation_required");
        this.store.db
          .prepare(
            "DELETE FROM outbox WHERE grant_id=? AND acked=0 AND json_extract(json,'$.kind')='quota'",
          )
          .run(g.id);
      }
    }
    for (const grant of this.grants().filter(
      (g) =>
        !g.revoked &&
        !g.paused &&
        (!connectionId || g.connectionId === connectionId),
    )) {
      const waiting = this.reconcile(grant),
        accounts = JSON.stringify(grant.accountIds),
        projects = JSON.stringify(grant.projectIds),
        hold = JSON.stringify([...waiting]);
      const from = new Date(
          Math.max(
            Date.parse(grant.from),
            Date.now() - grant.retentionDays * 86400000,
          ),
        ).toISOString(),
        to = new Date(
          Math.min(Date.parse(grant.to), Date.now() + 300000),
        ).toISOString();
      const accountExpr = (a: string, column: string) => {
        const manual = `(SELECT b.account_id FROM bindings b WHERE b.source_id=json_extract(${column},'$.sourceId') AND b.revoked=0 AND b.evidence='manual' AND b.from_at<=${a}.occurred_at AND b.to_at>${a}.occurred_at ORDER BY b.from_at DESC LIMIT 1)`;
        return `(CASE WHEN json_extract(${column},'$.data.accountEvidence') IN ('session_creator_only','database_creator_account_id','session_header') THEN ${manual} ELSE COALESCE(${a}.account_id,${manual}) END) IN (SELECT value FROM json_each(?))`;
      };
      const rows = this.store.db
        .prepare(
          `SELECT u.* FROM usage_points u JOIN sessions s ON s.id=u.session_id WHERE NOT EXISTS(SELECT 1 FROM outbox o WHERE o.event_id=u.id AND o.grant_id=?) AND u.occurred_at>=? AND u.occurred_at<=? AND u.project_id IN(SELECT value FROM json_each(?)) AND ${accountExpr("u", "u.event_json")} AND u.session_id NOT IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM sync_blocked b WHERE b.grant_id=? AND b.session_id=u.session_id) ORDER BY u.occurred_at,u.id LIMIT 2000`,
        )
        .all(grant.id, from, to, projects, accounts, hold, grant.id) as any[];
      for (const r of rows) {
        const w = this.wire(JSON.parse(r.event_json), grant, r.id);
        if (w) {
          w.kind = "usage";
          w.usage = delta(JSON.parse(r.usage));
          this.queue(w, grant);
        }
      }
      const states = this.store.db
        .prepare(
          `SELECT e.* FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.kind IN ('session_meta','turn_started','turn_completed','turn_failed','turn_cancelled','waiting_user','waiting_approval') AND e.occurred_at>=? AND e.occurred_at<=? AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.event_id=e.id AND o.grant_id=?) AND e.project_id IN(SELECT value FROM json_each(?)) AND ${accountExpr("e", "e.json")} AND NOT EXISTS(SELECT 1 FROM sync_blocked b WHERE b.grant_id=? AND b.session_id=e.session_id) ORDER BY e.occurred_at,e.id LIMIT 2000`,
        )
        .all(from, to, grant.id, projects, accounts, grant.id) as any[];
      for (const row of states) {
        const e = JSON.parse(row.json),
          w = this.wire(e, grant, e.id);
        if (w) this.queue(w, grant);
      }
      if (
        grant.shareQuota &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM sync_blocked WHERE grant_id=? AND session_id='@quota'",
          )
          .get(grant.id)
      )
        for (const q of this.store.quotas()) {
          if (!q.accountId || !grant.accountIds.includes(q.accountId)) continue;
          const identityEvidence = (
            q as typeof q & { identityEvidence?: string }
          ).identityEvidence;
          if (identityEvidence !== "manual" && identityEvidence !== "confirmed")
            continue;
          if (
            this.store
              .getSetting<string[]>("inactiveQuotaSources", [])
              .includes(q.sourceId)
          )
            continue;
          this.queue(
            {
              seq: 1,
              eventId: q.id,
              grantId: grant.id,
              provider: "codex",
              sourceId: q.sourceId,
              environmentId: this.store.getSetting("environmentId", "unknown"),
              sessionId: null,
              turnId: null,
              agentId: null,
              parentId: null,
              relation: null,
              accountId: q.accountId,
              projectId: null,
              kind: "quota",
              occurredAt: q.observedAt,
              observedAt: q.observedAt,
              model: null,
              state: null,
              evidence:
                identityEvidence === "confirmed" ? "confirmed" : "inferred",
              quota: {
                pool: q.pool,
                window: q.window,
                remainingPercent: q.remainingPercent,
                resetsAt: q.resetsAt,
              },
            },
            grant,
          );
        }
    }
  }
  private connectionState(id: string, value: any) {
    const states = this.store.getSetting<Record<string, any>>(
      "hubConnectionStates",
      {},
    );
    this.store.setSetting("hubConnectionStates", {
      ...states,
      [id]: { ...states[id], ...value },
    });
  }
  private heartbeat(connection: Connection) {
    const now = Date.now();
    const heartbeatSeq = this.store.transaction(() => {
      const counters = this.store.getSetting<Record<string, number>>(
        "heartbeatSequences",
        {},
      );
      const next = (counters[connection.id] ?? 0) + 1;
      if (!Number.isSafeInteger(next))
        throw Error("连接状态序号不可用，请重新连接");
      this.store.setSetting("heartbeatSequences", {
        ...counters,
        [connection.id]: next,
      });
      return next;
    });
    const grants = this.grants().filter(
      (g) =>
        g.connectionId === connection.id &&
        !g.revoked &&
        !g.revokedAt &&
        !g.paused &&
        Date.parse(g.from) <= now &&
        Date.parse(g.to) > now &&
        g.projectIds.length > 0 &&
        g.accountIds.length > 0,
    );
    // Only actual current-state evidence may disclose activity. A session's
    // creator account or another receiver's consent is not evidence of scope.
    const events = this.store.db
      .prepare(
        `SELECT e.json FROM sessions s JOIN events e
      ON e.session_id=s.id AND e.occurred_at=COALESCE(s.state_at,s.updated_at)
      WHERE s.state='running' AND COALESCE(s.state_at,s.updated_at)>?
      AND COALESCE(s.state_at,s.updated_at)<=? ORDER BY e.occurred_at DESC,e.id`,
      )
      .all(
        new Date(now - 15000).toISOString(),
        new Date(now + 1000).toISOString(),
      ) as { json: string }[];
    for (const g of grants)
      for (const row of events) {
        const e = JSON.parse(row.json) as Event;
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM sync_blocked WHERE grant_id=? AND session_id=?",
            )
            .get(g.id, e.sessionId)
        )
          continue;
        const w = this.wire(e, g, e.id);
        if (w && !withinGrant(w, g, now))
          return {
            heartbeatSeq,
            collectorHealth:
              this.store.getSetting<any>("collectorHealth", {}).health ??
              "unknown",
            taskState: "running",
            taskActivity: {
              grantId: g.id,
              accountId: w.accountId,
              projectId: w.projectId,
              occurredAt: e.occurredAt,
            },
          };
      }
    return {
      heartbeatSeq,
      collectorHealth:
        this.store.getSetting<any>("collectorHealth", {}).health ?? "unknown",
    };
  }
  private async syncTarget(connection: Connection) {
    try {
      this.enqueue(connection.id);
      await this.request(
        "/v1/heartbeat",
        "POST",
        this.heartbeat(connection),
        connection,
      );

      await this.flushRevocations(connection.id);
      const remote = await this.request(
        "/v1/grants?workspaceId=" + encodeURIComponent(connection.workspaceId),
        "GET",
        undefined,
        connection,
      );
      for (const g of remote.grants ?? [])
        if (g.revokedAt) {
          const local = this.grants().find(
            (x) => x.id === g.id && x.connectionId === connection.id,
          );
          if (local && !local.revoked)
            this.store.transaction(() => {
              this.store.db
                .prepare("UPDATE grants SET revoked=1 WHERE id=?")
                .run(g.id);
              this.store.db
                .prepare("DELETE FROM outbox WHERE grant_id=?")
                .run(g.id);
              this.store.audit("remote-withdraw-sharing", g.id);
            });
        }
      const batch = this.store.db
        .prepare(
          "SELECT o.* FROM outbox o JOIN grants g ON g.id=o.grant_id WHERE o.acked=0 AND g.revoked=0 AND COALESCE(json_extract(g.json,'$.paused'),0)=0 AND json_extract(g.json,'$.connectionId')=? AND NOT EXISTS(SELECT 1 FROM sync_blocked b WHERE b.grant_id=o.grant_id AND b.session_id=COALESCE(json_extract(o.json,'$.sessionId'),'@quota')) ORDER BY o.seq LIMIT 200",
        )
        .all(connection.id) as any[];
      if (batch.length) {
        const events = batch.map((r) => ({
            ...JSON.parse(r.json),
            seq: r.seq,
          })),
          batchId = hash(JSON.stringify(events));
        this.store.transaction(() => {
          for (const r of batch)
            this.store.db
              .prepare("INSERT OR IGNORE INTO sync_attempts VALUES(?)")
              .run(r.seq);
        });
        const ack = await this.request(
          "/v1/ingest",
          "POST",
          { protocolVersion: 1, batchId, events },
          connection,
        );
        const seqs = new Set(batch.map((r) => r.seq));
        if (
          !Number.isSafeInteger(ack.ackSeq) ||
          ack.ackSeq < Math.max(...seqs) ||
          !Array.isArray(ack.rejected) ||
          ack.accepted + ack.duplicates + ack.rejected.length !==
            batch.length ||
          ack.rejected.some((r: any) => !seqs.has(r.seq))
        )
          throw Error("无有效提交确认");
        const rejected = new Map<number, string>(
          ack.rejected.map((r: any) => [r.seq, r.reason]),
        );
        this.store.transaction(() => {
          for (const r of batch) {
            const w = JSON.parse(r.json) as WireEvent,
              reason = rejected.get(r.seq);
            this.store.db
              .prepare("UPDATE outbox SET acked=? WHERE seq=?")
              .run(reason ? 2 : 1, r.seq);
            if (reason) {
              const g = this.grants().find((g) => g.id === w.grantId);
              if (g) this.block(g, w, reason);
              continue;
            }
            if (w.kind === "usage") this.recordPoint(w);
            else if (w.kind === "usage_correction")
              this.store.db
                .prepare(
                  "UPDATE sync_point_state SET last_usage=?,revision=? WHERE grant_id=? AND event_id=? AND revision=?",
                )
                .run(
                  JSON.stringify(delta(w.usage)),
                  w.revision!,
                  w.grantId,
                  w.correctsEventId!,
                  w.expectedRevision!,
                );
          }
          if (ack.rejected.length)
            this.store.setSetting(
              "syncRejected",
              ack.rejected.map((r: any) => ({ seq: r.seq, reason: r.reason })),
            );
        });
      }
      this.connectionState(connection.id, {
        status: "在线 · 仅授权元数据",
        lastSyncAt: new Date().toISOString(),
        failures: 0,
        nextRetryAt: 0,
      });
      return true;
    } catch (error) {
      const previous = this.store.getSetting<Record<string, any>>(
        "hubConnectionStates",
        {},
      )[connection.id];
      this.connectionState(connection.id, {
        status: /HTTP (401|403)/.test(String(error))
          ? "设备凭据已撤销或授权不可用"
          : "离线或同步失败 · 本地继续采集",
        failures: (previous?.failures ?? 0) + 1,
        nextRetryAt:
          Date.now() +
          Math.min(
            60000,
            3000 * 2 ** Math.min((previous?.failures ?? 0) + 1, 5),
          ),
      });
      return false;
    }
  }
  override async once(force = true) {
    if (this.store.getSetting("indexRebuilding", false)) {
      this.status = "重建索引期间暂停同步，本地查看仍可用";
      return;
    }
    if (this.running || !this.connections().length || this.stopped) return;
    this.running = true;
    try {
      const connections = this.connections();
      const missed = this.store.db
        .prepare(
          "SELECT t.session_id FROM tombstones t WHERE EXISTS(SELECT 1 FROM json_each(?) c WHERE NOT EXISTS(SELECT 1 FROM sync_erased_targets s WHERE s.session_id=t.session_id AND s.connection_id=c.value))",
        )
        .all(JSON.stringify(connections.map((c) => c.id))) as {
        session_id: string;
      }[];
      if (missed.length)
        this.store.setSetting("pendingErases", [
          ...new Set([
            ...this.store.getSetting<string[]>("pendingErases", []),
            ...missed.map((r) => r.session_id),
          ]),
        ]);
      const targets = this.store.getSetting<Record<string, any>>(
        "hubConnectionStates",
        {},
      );
      const results = await Promise.all(
        connections.map((c) =>
          !force && targets[c.id]?.nextRetryAt > Date.now()
            ? Promise.resolve(false)
            : this.syncTarget(c),
        ),
      );
      const succeeded = results.filter(Boolean).length;
      this.failures = succeeded ? 0 : this.failures + 1;
      const blocked = (
        this.store.db
          .prepare(
            "SELECT count(*) n FROM sync_blocked b JOIN grants g ON g.id=b.grant_id WHERE g.revoked=0",
          )
          .get() as any
      ).n;
      this.status = blocked
        ? `同步需处理：${blocked} 个会话/额度流已暂停，请查看共享诊断；不会盲目覆盖`
        : succeeded === connections.length
          ? "在线 · 所有目标仅同步授权元数据"
          : succeeded
            ? `部分目标离线（${succeeded}/${connections.length} 在线）· 其他目标继续`
            : "离线或同步失败 · 本地继续采集";
      if (succeeded)
        this.store.setSetting("lastSyncAt", new Date().toISOString());
    } finally {
      this.running = false;
    }
  }
}
