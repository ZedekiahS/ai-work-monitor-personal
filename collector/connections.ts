import { hostname } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Store } from "../core/store.js";
import { SyncClient } from "./sync.js";
export function serviceOrigin(value: string) {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || u.pathname !== "/")
    throw Error("服务地址只能包含协议、主机和端口");
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw Error("远程服务必须使用 HTTPS");
  return u.origin;
}
function parseLink(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "aiwm:" ||
    !["join", "device"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw Error("请粘贴完整的 Monitor 邀请或配对链接");
  const url = serviceOrigin(u.searchParams.get("url") ?? ""),
    code = u.searchParams.get("code") ?? "";
  if (!/^[a-zA-Z0-9_-]{20,200}$/.test(code)) throw Error("链接中的邀请码无效");
  return { url, code, kind: u.hostname };
}
class ConnectionCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export class Connections {
  private accepting = new Map<string, Promise<any>>();
  private registering = new Map<string, Promise<any>>();
  constructor(
    private store: Store,
    private sync: SyncClient,
  ) {}
  private identities() {
    return this.store.getSetting<
      Record<string, { token: string; userId: string }>
    >("productIdentities", {});
  }
  private registrations() {
    return this.store.getSetting<Record<string, Registration | JoinIntent>>(
      "pendingRegistrations",
      {},
    );
  }
  pending() {
    return {
      items: Object.values(this.registrations()).map(
        ({
          id,
          url,
          workspaceId,
          userId,
          name,
          createdAt,
          stage,
          invalid,
        }) => ({
          id,
          url,
          workspaceId,
          userId,
          name,
          createdAt,
          stage: stage ?? "registering",
          invalid: invalid === true,
        }),
      ),
    };
  }
  private receiver(connectionId?: string) {
    const pair = this.sync.pairInfo();
    if (!connectionId || !pair || pair.id !== connectionId)
      throw Error("接收方已改变，请重新选择并确认目标连接");
    return pair;
  }
  confirmGrant(id: string, connectionId?: string) {
    const pair = this.receiver(connectionId);
    if (
      !this.sync.grants().some((g) => g.id === id && g.connectionId === pair.id)
    )
      throw Error("授权不属于当前确认的接收方");
  }
  private async call(
    url: string,
    route: string,
    method = "GET",
    body?: unknown,
    credential?: string,
  ) {
    const response = await fetch(serviceOrigin(url) + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(credential ? { Authorization: "Bearer " + credential } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    }).catch(() => {
      throw Error("无法连接服务，请检查网络与服务地址后重试");
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new ConnectionCallError(
        response.status === 401
          ? "产品凭据已失效，请恢复登录"
          : response.status === 409 &&
              ["/v1/invites/preview", "/v1/join", "/v1/pair/preview"].includes(
                route,
              )
            ? "此旧链接无法核实签发信息，请重新生成邀请或配对链接"
            : response.status === 409 && route === "/v1/self/register"
              ? "这次设备登记已改变或撤销，请重新登录后登记本机"
              : response.status === 403
                ? "没有此操作权限"
                : response.status === 400
                  ? "邀请、配对码或共享范围已失效，请检查后重试"
                  : `服务暂时无法完成请求 (${response.status})`,
        response.status,
      );
    return result as any;
  }
  async preview(link: string) {
    const p = parseLink(link),
      v = await this.call(
        p.url,
        p.kind === "join" ? "/v1/invites/preview" : "/v1/pair/preview",
        "POST",
        { code: p.code },
      );
    return { ...v, url: p.url, kind: p.kind };
  }
  async accept(link: string, name: string): Promise<any> {
    const key = createHash("sha256").update(link).digest("hex");
    const running = this.accepting.get(key);
    if (running) return running;
    const operation = this.acceptOnce(
      link,
      name,
      key,
      this.sync.selectionRevision(),
    );
    this.accepting.set(key, operation);
    try {
      return await operation;
    } finally {
      this.accepting.delete(key);
    }
  }
  private async acceptOnce(
    link: string,
    name: string,
    linkHash: string,
    selectionRevision: number,
  ) {
    const p = parseLink(link);
    const pending = Object.values(this.registrations()).find(
      (v) => v.linkHash === linkHash && v.url === p.url,
    );
    if (pending) return this.resume(pending.id, selectionRevision);
    const completed = this.store.getSetting<Record<string, string>>(
      "completedInvitations",
      {},
    )[linkHash];
    if (completed && this.sync.connections().some((c) => c.id === completed))
      return { ok: true, connectionId: completed };
    const preview = await this.preview(link);
    if (p.kind === "device") {
      return this.sync.pair(
        { url: p.url, code: p.code, name: preview.name },
        selectionRevision,
      );
    }
    const current = this.identities()[p.url];
    const intent: JoinIntent = {
      id: randomUUID(),
      stage: "joining",
      url: p.url,
      code: p.code,
      joinId: randomUUID(),
      joinProof: randomBytes(32).toString("base64url"),
      name: preview.name,
      displayName: name,
      linkHash,
      credential: current?.token,
      userId: current?.userId,
      createdAt: new Date().toISOString(),
    };
    // The proof is durable and encrypted before the first potentially committing
    // request. Joining and registering are separate recoverable transactions.
    this.store.setSetting("pendingRegistrations", {
      ...this.registrations(),
      [intent.id]: intent,
    });
    return this.resume(intent.id, selectionRevision);
  }
  private async join(pending: JoinIntent, selectionRevision: number) {
    try {
      const joined = await this.call(
        pending.url,
        "/v1/join",
        "POST",
        {
          code: pending.code,
          name: pending.displayName,
          joinId: pending.joinId,
          joinProof: pending.joinProof,
        },
        pending.credential,
      );
      // Joining can wait while another window recovers or changes the product
      // identity. Re-read the durable intent instead of restoring its captured
      // credential; an unrelated identity must never complete this join.
      const latest = this.registrations()[pending.id];
      if (
        latest?.stage !== "joining" ||
        latest.joinId !== pending.joinId ||
        latest.joinProof !== pending.joinProof
      )
        throw Error("待加入记录已改变，请刷新后重试");
      const identity = this.identities()[pending.url];
      if (identity && identity.userId !== joined.userId)
        throw Error("当前产品身份已改变，原加入记录已保留；请恢复原身份后继续");
      const credential =
        identity?.token ?? latest.credential ?? joined.productToken;
      if (
        !credential ||
        typeof joined.userId !== "string" ||
        typeof joined.workspaceId !== "string" ||
        (pending.userId && joined.userId !== pending.userId)
      )
        throw Error("服务返回的加入身份不匹配，请重试确认");
      const registration = this.prepareRegistration(
        pending.url,
        credential,
        joined.userId,
        joined.workspaceId,
        pending.name,
        pending.linkHash,
        pending.id,
      );
      return this.resume(registration.id, selectionRevision);
    } catch (error) {
      return {
        ok: false,
        pending: true,
        pendingId: pending.id,
        stage: "joining",
        name: pending.name,
        url: pending.url,
        error:
          error instanceof Error
            ? error.message
            : "邀请加入尚未确认，请继续加入",
      };
    }
  }
  private prepareRegistration(
    url: string,
    credential: string,
    userId: string,
    workspaceId: string,
    name: string,
    linkHash?: string,
    replacePendingId?: string,
  ) {
    const existing = Object.values(this.registrations()).find(
      (p): p is Registration =>
        p.stage !== "joining" &&
        p.url === url &&
        p.userId === userId &&
        p.workspaceId === workspaceId,
    );
    const pending: Registration = existing
      ? { ...existing, credential, ...(linkHash ? { linkHash } : {}) }
      : {
          id: randomUUID(),
          stage: "registering",
          url,
          credential,
          userId,
          workspaceId,
          name,
          linkHash,
          registrationId: randomUUID(),
          registrationToken: randomBytes(32).toString("base64url"),
          createdAt: new Date().toISOString(),
        };
    this.store.transaction(() => {
      this.store.setSetting("productIdentities", {
        ...this.identities(),
        [url]: { token: credential, userId },
      });
      const states = { ...this.registrations(), [pending.id]: pending };
      if (replacePendingId) delete states[replacePendingId];
      this.store.setSetting("pendingRegistrations", states);
    });
    return pending;
  }
  async resume(
    id: string,
    selectionRevision = this.sync.selectionRevision(),
  ): Promise<any> {
    const running = this.registering.get(id);
    if (running) return running;
    const pending = this.registrations()[id];
    if (!pending) throw Error("没有待完成的设备连接，请刷新连接列表");
    const operation =
      pending.stage === "joining"
        ? this.join(pending, selectionRevision)
        : this.register(pending, selectionRevision);
    this.registering.set(id, operation);
    try {
      return await operation;
    } finally {
      this.registering.delete(id);
    }
  }
  private async register(pending: Registration, selectionRevision: number) {
    if (pending.invalid)
      return this.registrationResult(
        pending,
        "此设备登记已失效，请明确恢复本人身份后重新登记",
      );
    const {
      url,
      credential,
      workspaceId,
      name,
      registrationId,
      registrationToken,
    } = pending;
    try {
      const v = await this.call(
        url,
        "/v1/self/register",
        "POST",
        {
          workspaceId,
          registrationId,
          registrationToken,
          label:
            hostname()
              .replace(/[^\p{L}\p{N} _.-]/gu, "")
              .slice(0, 60) || "我的电脑",
          deviceId: this.store.getSetting("deviceId", ""),
          environmentId: this.store.getSetting("environmentId", ""),
        },
        credential,
      );
      if (
        v.protocolVersion !== 1 ||
        !v.deviceToken ||
        !v.deviceId ||
        v.workspaceId !== workspaceId ||
        v.userId !== pending.userId
      )
        throw Error("服务返回的设备身份不匹配，请重试连接");
      const connection = this.store.transaction(() => {
        const c = this.sync.addConnection(
          { ...v, url, name },
          selectionRevision,
        );
        const registrations = this.registrations();
        delete registrations[pending.id];
        this.store.setSetting("pendingRegistrations", registrations);
        if (pending.linkHash)
          this.store.setSetting("completedInvitations", {
            ...this.store.getSetting("completedInvitations", {}),
            [pending.linkHash]: c.id,
          });
        return c;
      });
      return {
        ok: true,
        connectionId: connection.id,
        recoveryCode: credential,
      };
    } catch (e) {
      if (e instanceof ConnectionCallError && e.status === 409) {
        const states = this.registrations();
        const latest = states[pending.id];
        if (
          latest?.stage !== "joining" &&
          latest?.registrationId === pending.registrationId
        ) {
          pending = { ...latest, invalid: true };
          this.store.setSetting("pendingRegistrations", {
            ...states,
            [pending.id]: pending,
          });
        }
      }
      return this.registrationResult(
        pending,
        e instanceof Error ? e.message : "设备连接尚未完成，请重试",
      );
    }
  }
  private registrationResult(pending: Registration, error: string) {
    return {
      ok: false,
      pending: true,
      pendingId: pending.id,
      stage: "registering",
      invalid: pending.invalid === true,
      name: pending.name,
      url: pending.url,
      workspaceId: pending.workspaceId,
      recoveryCode: pending.credential,
      error,
    };
  }
  async restartRegistration(
    pendingId: string,
    recoveryCode: string,
  ): Promise<any> {
    const selectionRevision = this.sync.selectionRevision();
    const pending = this.registrations()[pendingId];
    if (!pending || pending.stage === "joining" || !pending.invalid)
      throw Error("只有已确认失效的设备登记可以重新登记；普通断网请继续原登记");
    if (this.registering.has(pendingId))
      throw Error("此登记正在处理，请稍后重试");
    const operation = this.replaceInvalidRegistration(
      pending,
      String(recoveryCode ?? ""),
      selectionRevision,
    );
    this.registering.set(pendingId, operation);
    try {
      return await operation;
    } finally {
      this.registering.delete(pendingId);
    }
  }
  private async replaceInvalidRegistration(
    pending: Registration,
    credential: string,
    selectionRevision: number,
  ) {
    if (!credential)
      throw Error("请提供本人产品恢复码，再取消失效登记并重新登记");
    const me = await this.call(
      pending.url,
      "/v1/me",
      "GET",
      undefined,
      credential,
    );
    const workspace = me.workspaces?.find(
      (w: any) => w.id === pending.workspaceId && w.active !== false,
    );
    if (me.user?.id !== pending.userId || !workspace)
      throw Error("恢复身份与待登记本人账号或空间不一致，原登记已保留");
    const replacement: Registration = {
      ...pending,
      id: randomUUID(),
      invalid: false,
      credential,
      registrationId: randomUUID(),
      registrationToken: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      const states = this.registrations(),
        current = states[pending.id];
      if (
        !current ||
        current.stage === "joining" ||
        current.registrationId !== pending.registrationId ||
        !current.invalid
      )
        throw Error("待登记记录已改变，请刷新后重试");
      delete states[pending.id];
      states[replacement.id] = replacement;
      this.store.setSetting("pendingRegistrations", states);
      this.store.setSetting("productIdentities", {
        ...this.identities(),
        [pending.url]: { token: credential, userId: pending.userId },
      });
      this.store.audit("restart-invalid-device-registration", pending.id);
    });
    return this.resume(replacement.id, selectionRevision);
  }
  async login(v: any) {
    const selectionRevision = this.sync.selectionRevision();
    const url = serviceOrigin(v.url),
      credential = String(v.recoveryCode ?? "");
    const me = await this.call(url, "/v1/me", "GET", undefined, credential);
    const spaces = me.workspaces.filter((w: any) =>
      v.personal ? w.kind === "personal" : w.kind === "company",
    );
    const w = v.workspaceId
      ? spaces.find((x: any) => x.id === v.workspaceId)
      : spaces.length === 1
        ? spaces[0]
        : null;
    if (!w)
      return {
        chooseWorkspace: true,
        workspaces: spaces.map((x: any) => ({ id: x.id, name: x.name })),
      };
    const pending = this.prepareRegistration(
      url,
      credential,
      me.user.id,
      w.id,
      w.name,
    );
    return this.resume(pending.id, selectionRevision);
  }
  async own(route: string, method = "GET", body?: any, connectionId?: string) {
    const pair = this.receiver(connectionId);
    const otherDevice = /^devices\/([^/]+)$/.exec(route);
    if (
      method === "DELETE" &&
      otherDevice &&
      decodeURIComponent(otherDevice[1]) !== pair.deviceId
    ) {
      const identity = this.identities()[pair.url];
      if (!identity || identity.userId !== pair.userId)
        throw Error("请先使用恢复码登录此产品账号，再撤销另一台设备");
      const value = await this.call(
        pair.url,
        "/v1/self/" +
          route +
          "?workspaceId=" +
          encodeURIComponent(pair.workspaceId),
        method,
        { ...body, workspaceId: pair.workspaceId },
        identity.token,
      );
      return { ...value, connectionId: pair.id };
    }
    const value = await this.sync.request(
      "/v1/self/" +
        route +
        (method === "GET" || method === "DELETE"
          ? (route.includes("?") ? "&" : "?") +
            "workspaceId=" +
            encodeURIComponent(pair.workspaceId)
          : ""),
      method,
      method === "GET" ? undefined : { ...body, workspaceId: pair.workspaceId },
      pair,
    );
    return { ...value, connectionId: pair.id };
  }
  async pairCode(connectionId?: string) {
    const pair = this.receiver(connectionId);
    const v = await this.own(
      "pair-codes",
      "POST",
      { label: "我的另一台电脑" },
      pair.id,
    );
    return {
      connectionId: pair.id,
      link: `aiwm://device?url=${encodeURIComponent(pair.url)}&code=${encodeURIComponent(v.code)}`,
      expiresAt: v.expiresAt,
    };
  }
  async records(connectionId?: string) {
    const pair = this.receiver(connectionId);
    let cursor: string | null = null,
      items: any[] = [],
      seen = new Set<string>();
    do {
      const v = await this.own(
        "records" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        "GET",
        undefined,
        pair.id,
      );
      items.push(...v.items);
      cursor = v.nextCursor;
      if (cursor && seen.has(cursor)) throw Error("导出分页异常，请重试");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { items, connectionId: pair.id };
  }
  async rotate(connectionId?: string) {
    const pair = this.receiver(connectionId);
    const v = await this.own(
      "devices/" + pair.deviceId + "/rotate",
      "POST",
      undefined,
      pair.id,
    );
    this.sync.updateCredential(pair.id, v.deviceToken);
    return { ok: true, connectionId: pair.id };
  }
  savedRecovery(connectionId?: string, pendingId?: string) {
    if (pendingId) {
      const pending = this.registrations()[pendingId];
      if (!pending) throw Error("待连接记录已改变，请刷新后重试");
      if (pending.stage === "joining")
        throw Error("邀请加入尚未确认，请先继续加入；恢复证明不会显示或导出");
      return {
        pendingId,
        recoveryCode: pending.credential,
        name: pending.name,
        url: pending.url,
      };
    }
    const pair = this.receiver(connectionId);
    const identity = this.identities()[pair.url];
    if (!identity || identity.userId !== pair.userId)
      throw Error("请先使用恢复码登录此产品账号");
    return { connectionId: pair.id, recoveryCode: identity.token };
  }
  async recovery(connectionId?: string) {
    const pair = this.receiver(connectionId);
    const identity = this.identities()[pair.url];
    if (!identity || identity.userId !== pair.userId)
      throw Error("请先使用现有恢复码登录此产品账号，再更新恢复码");
    const v = await this.call(
      pair.url,
      "/v1/self/recovery",
      "POST",
      { workspaceId: pair.workspaceId },
      identity.token,
    );
    this.store.transaction(() => {
      this.store.setSetting("productIdentities", {
        ...this.identities(),
        [pair.url]: { ...identity, token: v.productToken },
      });
      const registrations = this.registrations();
      for (const pending of Object.values(registrations))
        if (pending.url === pair.url && pending.userId === identity.userId)
          pending.credential = v.productToken;
      this.store.setSetting("pendingRegistrations", registrations);
    });
    return { recoveryCode: v.productToken, connectionId: pair.id };
  }
}

interface Registration {
  stage?: "registering";
  invalid?: boolean;
  id: string;
  url: string;
  credential: string;
  userId: string;
  workspaceId: string;
  name: string;
  registrationId: string;
  registrationToken: string;
  createdAt: string;
  linkHash?: string;
}
interface JoinIntent {
  id: string;
  stage: "joining";
  invalid?: false;
  url: string;
  code: string;
  joinId: string;
  joinProof: string;
  name: string;
  displayName: string;
  credential?: string;
  userId?: string;
  workspaceId?: undefined;
  createdAt: string;
  linkHash: string;
}
