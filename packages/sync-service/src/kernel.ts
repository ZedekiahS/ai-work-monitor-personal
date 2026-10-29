import { randomUUID, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ExportSnapshots } from "@ai-work-monitor/sync-protocol/pagination";
import { Pool, type PoolClient } from "pg";
import {
  HttpError,
  alias,
  asObject,
  date,
  fields,
  id,
  parseEvent,
  parseGrant,
  previewFields,
  withinGrant,
  type Grant,
} from "@ai-work-monitor/sync-protocol";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export type Principal = {
  type: "user" | "device";
  userId: string;
  name?: string;
  deviceId?: string;
  workspaceId?: string;
};
export type Db = Pool | PoolClient;
export const one = async (db: Db, sql: string, p: unknown[] = []) =>
  (await db.query(sql, p)).rows[0];
export const grantRow = (r: any): Grant => ({
  id: r.id,
  workspaceId: r.workspace_id,
  userId: r.user_id,
  accountIds: r.account_ids,
  projectIds: r.project_ids,
  from: new Date(r.starts_at).toISOString(),
  to: new Date(r.ends_at).toISOString(),
  shareQuota: r.share_quota,
  retentionDays: r.retention_days,
  revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
});
export class SyncService {
  private ownExports = new ExportSnapshots<{ eventId: string }>();
  readonly pool: Pool;
  readonly origins: Set<string>;
  readonly secure: boolean;
  protected limit = new Map<string, { start: number; n: number }>();
  constructor(options: {
    connectionString: string;
    origins?: string[];
    secure?: boolean;
  }) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    this.origins = new Set(
      options.origins ?? [
        "http://127.0.0.1:4318",
        "http://localhost:4318",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ],
    );
    this.secure = options.secure ?? false;
  }
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const v = await fn(c);
      await c.query("COMMIT");
      return v;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(492068131)");
      await c.query(
        await readFile(new URL("./migration.sql", import.meta.url), "utf8"),
      );
    });
  }
  async init(bootstrap?: { token: string; name?: string }) {
    await this.migrate();
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(492068131)");
      if (await one(c, "SELECT id FROM product_users LIMIT 1")) return;
      if (!bootstrap || bootstrap.token.length < 32)
        throw Error("Bootstrap credential must contain at least 32 characters");
      const uid = randomUUID(),
        wid = randomUUID();
      await c.query(
        "INSERT INTO product_users(id,name,token_hash) VALUES($1,$2,$3)",
        [uid, bootstrap.name ?? "我的账号", hash(bootstrap.token)],
      );
      await c.query(
        "INSERT INTO workspaces(id,name,kind) VALUES($1,'我的设备','personal')",
        [wid],
      );
      await c.query("INSERT INTO personal_owners VALUES($1,$2)", [wid, uid]);
    });
  }
  async close() {
    await this.pool.end();
  }
  protected async audit(
    c: Db,
    w: string,
    u: string,
    action: string,
    target: string | null = null,
  ) {
    await c.query(
      "INSERT INTO audit_events(workspace_id,actor_id,action,target_id) VALUES($1,$2,$3,$4)",
      [w, u, action, target],
    );
  }
  protected taskStateSql(device = "d") {
    return `CASE WHEN ${device}.revoked_at IS NULL AND ${device}.task_state_at>now()-interval '15 seconds' AND ${device}.task_state_at<=now()+interval '1 second' AND EXISTS(SELECT 1 FROM grants activity_grant WHERE activity_grant.id=${device}.task_grant_id AND activity_grant.workspace_id=${device}.workspace_id AND activity_grant.user_id=${device}.user_id AND activity_grant.revoked_at IS NULL AND activity_grant.starts_at<=now() AND activity_grant.ends_at>now()) THEN ${device}.task_state ELSE NULL END`;
  }
  protected async revokeDevice(c: Db, deviceId: string) {
    await c.query(
      "UPDATE devices SET revoked_at=COALESCE(revoked_at,now()),task_state=NULL,task_grant_id=NULL,task_state_at=NULL WHERE id=$1",
      [deviceId],
    );
    await c.query(
      "UPDATE pair_codes SET revoked_at=COALESCE(revoked_at,now()) WHERE issuer_device_id=$1 AND redeemed_at IS NULL",
      [deviceId],
    );
  }
  protected async authenticate(req: IncomingMessage): Promise<Principal> {
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith("Bearer ") || bearer.length > 300) {
      this.rateLimit(req);
      throw new HttpError(401, "Product or device credential required");
    }
    const h = hash(bearer.slice(7));
    const user = await one(
      this.pool,
      "SELECT id,name FROM product_users WHERE token_hash=$1",
      [h],
    );
    if (user) return { type: "user", userId: user.id, name: user.name };
    const device = await one(
      this.pool,
      "SELECT d.id,d.user_id,d.workspace_id FROM devices d WHERE d.token_hash=$1 AND d.revoked_at IS NULL",
      [h],
    );
    if (device) {
      await this.member(
        {
          type: "device",
          userId: device.user_id,
          workspaceId: device.workspace_id,
        },
        device.workspace_id,
        "pair",
      );
      return {
        type: "device",
        userId: device.user_id,
        deviceId: device.id,
        workspaceId: device.workspace_id,
      };
    }
    this.rateLimit(req);
    throw new HttpError(401, "Credential invalid or revoked");
  }
  protected user(p: Principal) {
    if (p.type !== "user")
      throw new HttpError(403, "Product user credential required");
  }
  protected async member(
    p: Principal,
    w: string,
    _action: string,
    c: Db = this.pool,
  ): Promise<string> {
    if (p.type === "device" && p.workspaceId !== w)
      throw new HttpError(403, "Device workspace mismatch");
    if (
      !(await one(
        c,
        "SELECT 1 FROM personal_owners WHERE workspace_id=$1 AND user_id=$2",
        [w, p.userId],
      ))
    )
      throw new HttpError(403, "Personal scope denied");
    return "owner";
  }
  protected async purgeGrant(c: Db, g: any, actor: string) {
    await c.query("SELECT id FROM product_users WHERE id=$1 FOR UPDATE", [
      g.user_id,
    ]);
    await c.query(
      "UPDATE grants SET revoked_at=COALESCE(revoked_at,now()),account_ids='[]'::jsonb,project_ids='[]'::jsonb WHERE id=$1",
      [g.id],
    );
    await c.query("DELETE FROM event_grants WHERE grant_id=$1", [g.id]);
    await c.query(
      "DELETE FROM shared_events e WHERE workspace_id=$1 AND user_id=$2 AND NOT EXISTS(SELECT 1 FROM event_grants eg JOIN grants g ON g.id=eg.grant_id WHERE eg.workspace_id=e.workspace_id AND eg.user_id=e.user_id AND eg.event_id=e.event_id AND eg.expires_at>now() AND g.revoked_at IS NULL AND g.ends_at>now())",
      [g.workspace_id, g.user_id],
    );
    await this.audit(
      c,
      g.workspace_id,
      actor,
      "grant.withdraw_and_purge",
      g.id,
    );
  }
  protected async body(req: IncomingMessage) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > 2 * 1024 * 1024) throw new HttpError(413, "Request too large");
      chunks.push(b);
    }
    try {
      return asObject(
        JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      );
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "Invalid JSON");
    }
  }
  protected send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  }

  protected async sharedRoute(
    req: IncomingMessage,
    res: ServerResponse,
    path: URL,
    method: string,
    body: Record<string, unknown>,
    principal?: Principal,
  ): Promise<boolean> {
    if (path.pathname === "/v1/pair/preview" && method === "POST") {
      fields(body, ["code"]);
      const pair = await one(
        this.pool,
        "SELECT w.name,w.kind,pc.expires_at,pc.issuer_kind FROM pair_codes pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.code_hash=$1 AND pc.redeemed_at IS NULL AND pc.revoked_at IS NULL AND pc.expires_at>now() AND (pc.issuer_device_id IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.id=pc.issuer_device_id AND d.revoked_at IS NULL))",
        [hash(id(body.code))],
      );
      if (!pair) throw new HttpError(400, "配对链接已失效，请重新生成");
      // Read-time proof check is reversible: no legacy row is consumed or
      // revoked. A newly generated link supplies verifiable issuer scope.
      if (!pair.issuer_kind)
        throw new HttpError(
          409,
          "此配对链接缺少签发信息，请在已登录设备重新生成",
        );
      this.send(res, 200, {
        name: pair.name,
        kind: "device",
        workspaceKind: pair.kind,
        expiresAt: pair.expires_at,
      });
      return true;
    }
    if (path.pathname === "/v1/pair/redeem" && method === "POST") {
      fields(body, ["code", "label", "deviceId", "environmentId"]);
      const code = id(body.code),
        label = alias(body.label),
        physical = id(body.deviceId),
        env = id(body.environmentId);
      const result = await this.tx(async (c) => {
        const pair = await one(
          c,
          "SELECT * FROM pair_codes WHERE code_hash=$1 FOR UPDATE",
          [hash(code)],
        );
        if (
          !pair ||
          pair.redeemed_at ||
          pair.revoked_at ||
          new Date(pair.expires_at).getTime() <= Date.now()
        )
          throw new HttpError(400, "Pair code expired or consumed");
        if (!pair.issuer_kind)
          throw new HttpError(
            409,
            "此配对链接缺少签发信息，请在已登录设备重新生成",
          );
        if (
          pair.issuer_device_id &&
          !(await one(
            c,
            "SELECT id FROM devices WHERE id=$1 AND revoked_at IS NULL FOR SHARE",
            [pair.issuer_device_id],
          ))
        )
          throw new HttpError(400, "Pairing issuer has been revoked");
        await this.member(
          { type: "user", userId: pair.user_id },
          pair.workspace_id,
          "pair",
          c,
        );
        const deviceId = randomUUID(),
          deviceToken = token();
        await c.query(
          "UPDATE pair_codes SET redeemed_at=now() WHERE code_hash=$1",
          [hash(code)],
        );
        await c.query(
          "INSERT INTO devices(id,workspace_id,user_id,physical_id,environment_id,label,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            deviceId,
            pair.workspace_id,
            pair.user_id,
            physical,
            env,
            label,
            hash(deviceToken),
          ],
        );
        await this.audit(
          c,
          pair.workspace_id,
          pair.user_id,
          "device.pair",
          deviceId,
        );
        return {
          deviceId,
          deviceToken,
          kind: (
            await one(c, "SELECT kind FROM workspaces WHERE id=$1", [
              pair.workspace_id,
            ])
          ).kind,
          workspaceId: pair.workspace_id,
          userId: pair.user_id,
          protocolVersion: 1,
        };
      });
      this.send(res, 201, result);
      return true;
    }

    const p = principal ?? (await this.authenticate(req));
    if (path.pathname === "/v1/heartbeat" && method === "POST") {
      if (p.type !== "device")
        throw new HttpError(403, "Device credential required");
      fields(body, [
        "collectorHealth",
        "taskState",
        "taskActivity",
        "heartbeatSeq",
      ]);
      const seq = body.heartbeatSeq;
      if (seq !== undefined && (!Number.isSafeInteger(seq) || Number(seq) < 1))
        throw new HttpError(400, "Invalid heartbeat sequence");
      if (
        !["healthy", "scanning", "error", "paused", "unknown"].includes(
          String(body.collectorHealth),
        ) ||
        (body.taskState !== undefined &&
          !["running", "idle", "unknown"].includes(String(body.taskState)))
      )
        throw new HttpError(400, "Invalid health state");
      await this.member(p, p.workspaceId!, "pair");
      let grantId: string | null = null,
        occurredAt: string | null = null;
      if (
        seq !== undefined &&
        body.taskActivity &&
        body.taskState === "running"
      ) {
        const activity = asObject(body.taskActivity);
        fields(activity, ["grantId", "accountId", "projectId", "occurredAt"]);
        const at = date(activity.occurredAt);
        if (
          Date.parse(at) > Date.now() - 15000 &&
          Date.parse(at) <= Date.now() + 1000
        ) {
          const grant = await one(
            this.pool,
            "SELECT id FROM grants WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND revoked_at IS NULL AND starts_at<=now() AND ends_at>now() AND starts_at<=$4 AND ends_at>$4 AND account_ids ? $5 AND project_ids ? $6",
            [
              id(activity.grantId),
              p.workspaceId,
              p.userId,
              at,
              id(activity.accountId),
              id(activity.projectId),
            ],
          );
          if (grant) {
            grantId = grant.id;
            occurredAt = at;
          }
        }
      }
      if (seq === undefined)
        await this.pool.query(
          "UPDATE devices SET last_seen_at=now(),collector_health=$2,task_state=NULL,task_grant_id=NULL,task_state_at=NULL WHERE id=$1 AND revoked_at IS NULL AND heartbeat_seq=0",
          [p.deviceId, body.collectorHealth],
        );
      else
        await this.pool.query(
          "UPDATE devices SET last_seen_at=now(),collector_health=$2,task_state=$3,task_grant_id=$4,task_state_at=$5,heartbeat_seq=$6 WHERE id=$1 AND revoked_at IS NULL AND heartbeat_seq<$6",
          [
            p.deviceId,
            body.collectorHealth,
            grantId ? "running" : null,
            grantId,
            occurredAt,
            seq,
          ],
        );
      this.send(res, 200, { ok: true, serverTime: new Date().toISOString() });
      return true;
    }
    if (path.pathname.startsWith("/v1/self/"))
      return this.selfRoute(res, path, method, body, p);
    if (path.pathname === "/v1/grants" && method === "GET") {
      const w = path.searchParams.get("workspaceId") ?? p.workspaceId;
      if (!w) throw new HttpError(400, "workspaceId required");
      await this.member(p, id(w), "view");
      const rows = (
        await this.pool.query(
          "SELECT g.* FROM grants g WHERE g.user_id=$1 AND ($2::text IS NULL OR g.workspace_id=$2) ORDER BY g.created_at DESC",
          [p.userId, w ?? null],
        )
      ).rows;
      this.send(res, 200, {
        grants: rows.map(grantRow),
        previewFields,
        metadataOnly: true,
      });
      return true;
    }
    if (path.pathname === "/v1/grants" && method === "POST") {
      const g = parseGrant(body);
      await this.member(p, g.workspaceId, "grant");
      const gid = randomUUID();
      await this.tx(async (c) => {
        await this.member(p, g.workspaceId, "grant", c);
        await c.query(
          "INSERT INTO grants(id,workspace_id,user_id,account_ids,project_ids,starts_at,ends_at,share_quota,retention_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            gid,
            g.workspaceId,
            p.userId,
            JSON.stringify(g.accountIds),
            JSON.stringify(g.projectIds),
            g.from,
            g.to,
            g.shareQuota,
            g.retentionDays,
          ],
        );
        await this.audit(c, g.workspaceId, p.userId, "grant.create", gid);
      });
      this.send(res, 201, {
        ...g,
        id: gid,
        userId: p.userId,
        previewFields,
        metadataOnly: true,
      });
      return true;
    }
    const gm = path.pathname.match(/^\/v1\/grants\/([^/]+)$/);
    if (gm && method === "DELETE") {
      const gid = id(gm[1]);
      await this.tx(async (c) => {
        await c.query("SELECT id FROM product_users WHERE id=$1 FOR UPDATE", [
          p.userId,
        ]);
        const g = await one(c, "SELECT * FROM grants WHERE id=$1 FOR UPDATE", [
          gid,
        ]);
        if (!g || g.user_id !== p.userId)
          throw new HttpError(404, "Grant not found");
        await this.member(p, g.workspace_id, "view", c);
        await this.purgeGrant(c, g, p.userId);
      });
      this.send(res, 200, { ok: true, purged: true, exportRecall: false });
      return true;
    }
    if (path.pathname === "/v1/ingest" && method === "POST") {
      if (p.type !== "device")
        throw new HttpError(403, "Device credential required");
      this.send(res, 200, await this.ingest(p, body));
      return true;
    }
    if (path.pathname === "/v1/erase" && method === "POST") {
      fields(body, ["workspaceId", "sessionId", "eventId"]);
      const w = id(body.workspaceId ?? p.workspaceId);
      await this.member(p, w, "grant");
      const scope = body.sessionId ? "session" : "event",
        target = id(body.sessionId ?? body.eventId);
      await this.tx(async (c) => {
        await c.query(
          "SELECT id FROM product_users WHERE id=$2 AND $1::text IS NOT NULL FOR UPDATE",
          [w, p.userId],
        );
        await c.query(
          "INSERT INTO tombstones(workspace_id,user_id,scope,target_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [w, p.userId, scope, target],
        );
        await c.query(
          `DELETE FROM shared_events WHERE workspace_id=$1 AND user_id=$2 AND ${scope === "session" ? "session_id" : "event_id"}=$3`,
          [w, p.userId, target],
        );
        await this.audit(c, w, p.userId, "monitor.erase_" + scope, target);
      });
      this.send(res, 200, { ok: true });
      return true;
    }

    return this.ownRoute(req, res, path, method, body, p);
  }
  protected async ownRoute(
    _req: IncomingMessage,
    res: ServerResponse,
    path: URL,
    method: string,
    body: Record<string, unknown>,
    p: Principal,
  ): Promise<boolean> {
    this.user(p);
    if (path.pathname === "/v1/me" && method === "GET") {
      const rows = (
        await this.pool.query(
          "SELECT w.*, 'owner' AS role, true AS active FROM workspaces w JOIN personal_owners o ON o.workspace_id=w.id WHERE o.user_id=$1",
          [p.userId],
        )
      ).rows;
      this.send(res, 200, {
        user: { id: p.userId, name: p.name },
        workspaces: rows,
      });
      return true;
    }
    return false;
  }
  handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.origin) {
        if (!this.origins.has(req.headers.origin))
          throw new HttpError(403, "Origin not allowed");
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const path = new URL(req.url ?? "/", "http://localhost");
      if (path.pathname === "/health") {
        this.send(res, 200, { ok: true, protocolVersion: 1, mode: "personal" });
        return;
      }
      if (this.secure && !(req.socket as any).encrypted)
        throw new HttpError(426, "TLS required");
      const principal = req.headers.authorization
        ? await this.authenticate(req)
        : undefined;
      this.rateLimit(req, principal);
      const body = ["POST", "PATCH"].includes(req.method ?? "")
        ? await this.body(req)
        : {};
      if (
        !(await this.sharedRoute(
          req,
          res,
          path,
          req.method ?? "GET",
          body,
          principal,
        ))
      )
        throw new HttpError(404, "Route not found");
    } catch (e) {
      this.send(res, e instanceof HttpError ? e.status : 500, {
        code: e instanceof HttpError ? e.code : "internal_error",
        error: e instanceof HttpError ? e.message : "Service unavailable",
      });
    }
  };
  async ingest(p: Principal, body: Record<string, unknown>) {
    fields(body, ["protocolVersion", "batchId", "events"]);
    if (body.protocolVersion !== 1)
      throw new HttpError(400, "Unsupported protocol version");
    const batchId = id(body.batchId);
    if (
      !Array.isArray(body.events) ||
      body.events.length > 500 ||
      body.events.length < 1
    )
      throw new HttpError(400, "Batch must contain 1..500 events");
    const raw = body.events;
    const digest = hash(JSON.stringify(body));
    return this.tx(async (c) => {
      await c.query("SELECT id FROM product_users WHERE id=$1 FOR UPDATE", [
        p.userId,
      ]);
      await this.member(p, p.workspaceId!, "pair", c);
      const device = await one(
        c,
        "SELECT * FROM devices WHERE id=$1 FOR UPDATE",
        [p.deviceId],
      );
      if (!device || device.revoked_at)
        throw new HttpError(401, "Device revoked");
      const old = await one(
        c,
        "SELECT payload_hash,response FROM batches WHERE device_id=$1 AND batch_id=$2",
        [p.deviceId, batchId],
      );
      if (old) {
        if (old.payload_hash !== digest)
          throw new HttpError(409, "Batch ID reused with different contents");
        return old.response;
      }
      const response = {
        ackSeq: Number(device.ack_seq),
        accepted: 0,
        duplicates: 0,
        rejected: [] as { seq: number; reason: string }[],
      };
      for (const value of raw) {
        const e = parseEvent(value),
          eh = hash(JSON.stringify(e));
        const receipt = await one(
          c,
          "SELECT payload_hash,result FROM receipts WHERE device_id=$1 AND seq=$2",
          [p.deviceId, e.seq],
        );
        if (receipt) {
          if (receipt.payload_hash !== eh)
            throw new HttpError(409, "Sequence reused with different contents");
          if (receipt.result === "accepted") response.duplicates++;
          else response.rejected.push({ seq: e.seq, reason: receipt.result });
          response.ackSeq = Math.max(response.ackSeq, e.seq);
          continue;
        }
        const gr = await one(c, "SELECT * FROM grants WHERE id=$1 FOR UPDATE", [
          e.grantId,
        ]);
        let reason =
          !gr || gr.workspace_id !== p.workspaceId || gr.user_id !== p.userId
            ? "grant_not_owned"
            : withinGrant(e, grantRow(gr));
        if (!reason) {
          const tomb = await one(
            c,
            "SELECT 1 FROM tombstones WHERE workspace_id=$1 AND user_id=$2 AND ((scope='event' AND target_id=$3) OR (scope='session' AND target_id=$4))",
            [p.workspaceId, p.userId, e.eventId, e.sessionId],
          );
          if (tomb) reason = "persistently_deleted";
        }
        const existing = await one(
          c,
          "SELECT payload FROM shared_events WHERE workspace_id=$1 AND user_id=$2 AND event_id=$3",
          [p.workspaceId, p.userId, e.eventId],
        );
        if (!reason && existing) {
          const signature = (v: any) =>
            JSON.stringify([
              v.kind,
              v.accountId,
              v.projectId,
              v.sessionId,
              v.turnId,
              v.occurredAt,
              v.usage ?? null,
              v.quota ?? null,
              v.correctsEventId ?? null,
              v.expectedRevision ?? null,
              v.revision ?? null,
            ]);
          if (signature(existing.payload) !== signature(e))
            reason = "business_event_conflict";
        }
        if (!reason && !existing && e.kind === "usage_correction") {
          const original = await one(
            c,
            "SELECT * FROM shared_events WHERE workspace_id=$1 AND user_id=$2 AND event_id=$3 FOR UPDATE",
            [p.workspaceId, p.userId, e.correctsEventId],
          );
          if (
            !original ||
            original.kind !== "usage" ||
            !original.payload.usage ||
            new Date(original.expires_at).getTime() <= Date.now()
          )
            reason = "correction_target_unavailable";
          else if (
            !(await one(
              c,
              "SELECT 1 FROM event_grants WHERE workspace_id=$1 AND user_id=$2 AND event_id=$3 AND grant_id=$4",
              [p.workspaceId, p.userId, e.correctsEventId, e.grantId],
            )) ||
            original.session_id !== e.sessionId ||
            original.account_id !== e.accountId ||
            original.project_id !== e.projectId ||
            new Date(original.occurred_at).toISOString() !== e.occurredAt
          )
            reason = "correction_scope_mismatch";
          else {
            const latest = await one(
              c,
              "SELECT COALESCE(MAX((payload->>'revision')::int),0) AS revision FROM shared_events WHERE workspace_id=$1 AND user_id=$2 AND kind='usage_correction' AND payload->>'correctsEventId'=$3",
              [p.workspaceId, p.userId, e.correctsEventId],
            );
            if (latest.revision !== e.expectedRevision)
              reason = "correction_revision_conflict";
          }
        }
        if (reason) response.rejected.push({ seq: e.seq, reason });
        else {
          const expires = new Date(
            Date.parse(e.occurredAt) + gr.retention_days * 86400000,
          ).toISOString();
          const inserted = await c.query(
            "INSERT INTO shared_events(workspace_id,user_id,event_id,grant_id,device_id,account_id,project_id,session_id,kind,occurred_at,observed_at,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING",
            [
              p.workspaceId,
              p.userId,
              e.eventId,
              e.grantId,
              p.deviceId,
              e.accountId,
              e.projectId,
              e.sessionId,
              e.kind,
              e.occurredAt,
              e.observedAt,
              JSON.stringify(e),
              expires,
            ],
          );
          await c.query(
            "INSERT INTO event_grants(workspace_id,user_id,event_id,grant_id,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [p.workspaceId, p.userId, e.eventId, e.grantId, expires],
          );
          await c.query(
            "UPDATE shared_events SET expires_at=GREATEST(expires_at,$4::timestamptz) WHERE workspace_id=$1 AND user_id=$2 AND event_id=$3",
            [p.workspaceId, p.userId, e.eventId, expires],
          );
          if (inserted.rowCount) {
            response.accepted++;
            if (e.kind === "usage_correction")
              await this.audit(
                c,
                p.workspaceId!,
                p.userId,
                "usage.correct",
                e.correctsEventId!,
              );
          } else response.duplicates++;
        }
        await c.query(
          "INSERT INTO receipts(device_id,seq,payload_hash,result) VALUES($1,$2,$3,$4)",
          [p.deviceId, e.seq, eh, reason ?? "accepted"],
        );
        response.ackSeq = Math.max(response.ackSeq, e.seq);
      }
      await c.query(
        "UPDATE devices SET ack_seq=$2,last_seen_at=now() WHERE id=$1",
        [p.deviceId, response.ackSeq],
      );
      await c.query(
        "INSERT INTO batches(device_id,batch_id,payload_hash,response) VALUES($1,$2,$3,$4)",
        [p.deviceId, batchId, digest, JSON.stringify(response)],
      );
      return response;
    });
  }

  async expire() {
    await this.tx(async (c) => {
      await c.query(
        "INSERT INTO tombstones(workspace_id,user_id,scope,target_id) SELECT workspace_id,user_id,'event',event_id FROM shared_events WHERE expires_at<=now() ON CONFLICT DO NOTHING",
      );
      await c.query(
        "DELETE FROM event_grants eg USING grants g WHERE eg.grant_id=g.id AND (eg.expires_at<=now() OR g.revoked_at IS NOT NULL OR g.ends_at<=now())",
      );
      await c.query(
        "DELETE FROM shared_events e WHERE expires_at<=now() OR NOT EXISTS(SELECT 1 FROM event_grants eg WHERE eg.workspace_id=e.workspace_id AND eg.user_id=e.user_id AND eg.event_id=e.event_id)",
      );
    });
  }

  protected rateLimit(req: IncomingMessage, p?: Principal) {
    const key = p
      ? `${p.type}:${p.deviceId ?? p.userId}`
      : `anonymous:${req.socket.remoteAddress ?? "?"}`;
    const now = Date.now();
    for (const [k, v] of this.limit)
      if (now - v.start > 60000) this.limit.delete(k);
    let bucket = this.limit.get(key);
    if (!bucket) {
      bucket = { start: now, n: 0 };
      this.limit.set(key, bucket);
    }
    if (++bucket.n > (p?.type === "device" ? 120 : p ? 240 : 60))
      throw new HttpError(429, "Rate limit exceeded");
  }
  protected async selfRoute(
    res: ServerResponse,
    path: URL,
    method: string,
    body: Record<string, unknown>,
    p: Principal,
  ): Promise<boolean> {
    const w = id(
      body.workspaceId ?? path.searchParams.get("workspaceId") ?? p.workspaceId,
    );
    await this.member(p, w, "view");
    if (path.pathname === "/v1/self/pair-codes" && method === "POST") {
      fields(body, ["workspaceId", "label"]);
      await this.member(p, w, "pair");
      const code = token(),
        expiresAt = new Date(Date.now() + 600000).toISOString();
      await this.tx(async (c) => {
        if (
          p.type === "device" &&
          !(await one(
            c,
            "SELECT id FROM devices WHERE id=$1 AND revoked_at IS NULL FOR SHARE",
            [p.deviceId],
          ))
        )
          throw new HttpError(401, "Device has been revoked");
        await c.query(
          "INSERT INTO pair_codes(code_hash,workspace_id,user_id,label,expires_at,issuer_device_id,issuer_kind) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            hash(code),
            w,
            p.userId,
            alias(body.label ?? "我的电脑"),
            expiresAt,
            p.deviceId ?? null,
            p.type,
          ],
        );
      });
      this.send(res, 201, { code, expiresAt, workspaceId: w });
      return true;
    }
    if (path.pathname === "/v1/self/register" && method === "POST") {
      this.user(p);
      fields(body, [
        "workspaceId",
        "label",
        "deviceId",
        "environmentId",
        "registrationId",
        "registrationToken",
      ]);
      await this.member(p, w, "pair");
      const registrationId =
        body.registrationId === undefined ? null : id(body.registrationId);
      if (
        (registrationId === null) !== (body.registrationToken === undefined) ||
        (registrationId !== null &&
          !/^[a-zA-Z0-9_-]{43}$/.test(String(body.registrationToken)))
      )
        throw new HttpError(
          400,
          "A registration requires a 32-byte random credential",
        );
      let deviceId = randomUUID();
      const deviceToken =
        registrationId === null ? token() : String(body.registrationToken);
      await this.tx(async (c) => {
        await this.member(p, w, "pair", c);
        if (registrationId) {
          await c.query("SELECT id FROM product_users WHERE id=$1 FOR UPDATE", [
            p.userId,
          ]);
          const previous = await one(
            c,
            "SELECT d.* FROM device_registrations r JOIN devices d ON d.id=r.device_id WHERE r.user_id=$1 AND r.workspace_id=$2 AND r.registration_id=$3 FOR UPDATE OF d",
            [p.userId, w, registrationId],
          );
          if (previous) {
            if (
              previous.revoked_at ||
              previous.token_hash !== hash(deviceToken) ||
              previous.physical_id !== id(body.deviceId) ||
              previous.environment_id !== id(body.environmentId)
            )
              throw new HttpError(
                409,
                "Registration changed or revoked; start a new registration",
              );
            deviceId = previous.id;
            return;
          }
        }
        await c.query(
          "INSERT INTO devices(id,workspace_id,user_id,physical_id,environment_id,label,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            deviceId,
            w,
            p.userId,
            id(body.deviceId),
            id(body.environmentId),
            alias(body.label),
            hash(deviceToken),
          ],
        );
        if (registrationId)
          await c.query(
            "INSERT INTO device_registrations VALUES($1,$2,$3,$4)",
            [p.userId, w, registrationId, deviceId],
          );
        await this.audit(c, w, p.userId, "device.register", deviceId);
      });
      this.send(res, 201, {
        deviceId,
        deviceToken,
        workspaceId: w,
        userId: p.userId,
        protocolVersion: 1,
        kind: (
          await one(this.pool, "SELECT kind FROM workspaces WHERE id=$1", [w])
        ).kind,
      });
      return true;
    }
    if (path.pathname === "/v1/self/devices" && method === "GET") {
      const devices = (
        await this.pool.query(
          `SELECT d.id,d.label,d.revoked_at AS "revokedAt",d.last_seen_at AS "lastSeenAt",d.collector_health AS "collectorHealth",${this.taskStateSql()} AS "taskState" FROM devices d WHERE d.workspace_id=$1 AND d.user_id=$2 ORDER BY d.created_at`,
          [w, p.userId],
        )
      ).rows;
      this.send(res, 200, { devices });
      return true;
    }
    const device = path.pathname.match(
      /^\/v1\/self\/devices\/([^/]+)(\/rotate)?$/,
    );
    if (device && (method === "DELETE" || (method === "POST" && device[2]))) {
      if (p.type === "device" && p.deviceId !== id(device[1]))
        throw new HttpError(
          403,
          "Product identity required to change another device credential",
        );
      const next = token();
      await this.tx(async (c) => {
        const target = await one(
          c,
          "SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE",
          [w, p.userId, id(device[1])],
        );
        if (!target) throw new HttpError(404, "Own device not found");
        if (device[2]) {
          const result = await c.query(
            "UPDATE devices SET token_hash=$2,credential_updated_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id",
            [target.id, hash(next)],
          );
          if (!result.rowCount)
            throw new HttpError(404, "Own device not found");
        } else await this.revokeDevice(c, target.id);
        await this.audit(
          c,
          w,
          p.userId,
          device[2] ? "device.rotate" : "device.revoke",
          device[1],
        );
      });
      this.send(res, 200, device[2] ? { deviceToken: next } : { ok: true });
      return true;
    }
    if (path.pathname === "/v1/self/recovery" && method === "POST") {
      this.user(p);
      fields(body, ["workspaceId"]);
      const next = token();
      await this.pool.query(
        "UPDATE product_users SET token_hash=$2 WHERE id=$1",
        [p.userId, hash(next)],
      );
      this.send(res, 200, { productToken: next });
      return true;
    }
    if (path.pathname === "/v1/self/overview" && method === "GET") {
      const usage = (
        await this.pool.query(
          `WITH scoped AS(SELECT * FROM authorized_events WHERE workspace_id=$1 AND user_id=$2),effective AS(SELECT e.*,COALESCE(c.payload->'usage',e.payload->'usage') u FROM scoped e LEFT JOIN LATERAL(SELECT payload FROM scoped c WHERE c.kind='usage_correction' AND c.payload->>'correctsEventId'=e.event_id ORDER BY (c.payload->>'revision')::integer DESC LIMIT 1)c ON true WHERE e.kind='usage' AND e.payload ? 'usage') SELECT account_id AS "accountId",SUM((u->>'input')::bigint)::text AS input,SUM((u->>'output')::bigint)::text AS output,COUNT(DISTINCT session_id)::int AS "taskCount" FROM effective GROUP BY account_id`,
          [w, p.userId],
        )
      ).rows.map((r) => ({
        ...r,
        input: Number(r.input),
        output: Number(r.output),
        total: Number(r.input) + Number(r.output),
      }));
      const quotas = (
        await this.pool.query(
          `SELECT DISTINCT ON(account_id,payload->'quota'->>'pool',payload->'quota'->>'window') account_id AS "accountId",payload->'quota' AS quota,observed_at AS "observedAt" FROM authorized_events WHERE workspace_id=$1 AND user_id=$2 AND payload ? 'quota' ORDER BY account_id,payload->'quota'->>'pool',payload->'quota'->>'window',observed_at DESC`,
          [w, p.userId],
        )
      ).rows;
      this.send(res, 200, { usage, quotas });
      return true;
    }
    if (path.pathname === "/v1/self/records" && method === "GET") {
      const cursor = path.searchParams.get("cursor"),
        scope = JSON.stringify([p.userId, w]);
      const keys = cursor
        ? []
        : (
            await this.pool.query(
              'SELECT event_id AS "eventId" FROM authorized_events WHERE workspace_id=$1 AND user_id=$2 ORDER BY occurred_at,event_id',
              [w, p.userId],
            )
          ).rows;
      const batch = this.ownExports.page(scope, cursor, () => keys, 200);
      const rows = (
        await this.pool.query(
          "SELECT event_id AS \"eventId\",payload FROM authorized_events WHERE workspace_id=$1 AND user_id=$2 AND event_id IN(SELECT x->>'eventId' FROM jsonb_array_elements($3::jsonb) x) ORDER BY occurred_at,event_id",
          [w, p.userId, JSON.stringify(batch.items)],
        )
      ).rows;
      this.send(res, 200, { ...batch, items: rows });
      return true;
    }
    return false;
  }
}
