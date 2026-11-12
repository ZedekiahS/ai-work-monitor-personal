/**
 * Adapted from codex-usage-desktop, Copyright (c) 2026 vincent, MIT.
 * Source: d7e04c43a7e1fe11c8dadee90908d70e19983569,
 * src-tauri/src/codex_limits.rs:751-772,1192-1346,1384-1401.
 * Full license: ../third_party/codex-usage-desktop-LICENSE.
 *
 * Changes: Rust -> TypeScript; bounded stdout/no stderr retention; single-flight,
 * persistent throttle/backoff; local hashed login-change guard; no OAuth/reset/activation or thread
 * operations; reject server-initiated requests; disable hooks; preserve multi-pool
 * windows/nulls; explicit unbound account isolation; do not bind historic events.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type { Quota } from "../core/model.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as ObjectValue)
    : null;
export type SpawnQuotaProcess = (
  command: string,
  args: string[],
) => ChildProcessWithoutNullStreams;
export const quotaCommandArgs = [
  "-c",
  "mcp_servers={}",
  "-c",
  "features.hooks=false",
  "-s",
  "read-only",
  "-a",
  "never",
  "app-server",
];
export class QuotaError extends Error {}
export class QuotaTimeoutError extends QuotaError {
  readonly stage: string;
  constructor(method: string) {
    const stages: Record<string, [string, string]> = {
      initialize: ["initialize", "额度服务启动"],
      "account/read": ["account", "账号读取"],
      "account/rateLimits/read": ["limits", "额度读取"],
      "account/usage/read": ["usage", "用量读取"],
    };
    const [stage, label] = stages[method] ?? ["unknown", "额度查询"];
    super(`Codex ${label}超时，请稍后重试`);
    this.stage = stage;
  }
}

export class QuotaRpc {
  private nextId = 1;
  private partial = "";
  private closed = false;
  private waiters = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stdout.on("end", () => this.fail("额度服务输出已关闭"));
    child.stderr.on("data", () => {
      /* Drain without storing secrets or diagnostics. */
    });
    child.stdin.on("error", () => this.fail("额度服务输入不可写"));
    child.on("error", () => this.fail("无法启动 Codex 额度服务"));
    child.on("close", () => this.fail("额度服务进程已结束"));
  }
  private receive(chunk: string) {
    if (this.closed) return;
    this.partial += chunk;
    if (Buffer.byteLength(this.partial, "utf8") > 2 * 1024 * 1024) {
      this.fail("额度服务响应超过限制");
      this.close();
      return;
    }
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      let message: ObjectValue | null = null;
      try {
        message = object(JSON.parse(line));
      } catch {
        continue;
      }
      if (!message) continue;
      if (typeof message.method === "string") {
        // Never satisfy server requests for token refresh, approvals or commands.
        if (message.id !== undefined)
          this.write({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Read-only monitoring client does not handle server requests",
            },
          });
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.waiters.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.waiters.delete(message.id);
      if (message.error)
        pending.reject(
          new QuotaError(
            "Codex 额度接口返回错误（未记录服务端原文；请检查原客户端登录或网络）",
          ),
        );
      else if (!Object.hasOwn(message, "result"))
        pending.reject(new QuotaError("额度服务响应缺少 result"));
      else pending.resolve(message.result);
    }
  }
  private write(v: unknown) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(v) + "\n");
  }
  request(method: string, params: unknown, timeout: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new QuotaError("额度服务不可用"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new QuotaTimeoutError(method));
      }, timeout);
      this.waiters.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.write({ method, params });
  }
  private fail(reason: string) {
    this.closed = true;
    for (const pending of this.waiters.values()) {
      clearTimeout(pending.timer);
      pending.reject(new QuotaError(reason));
    }
    this.waiters.clear();
  }
  close() {
    this.fail("额度探针已关闭");
    this.child.stdin.end();
    // Only the subprocess created by this adapter, never a user's existing process.
    if (this.child.exitCode === null) this.child.kill();
  }
}
const numeric = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const dateFromSeconds = (v: unknown): string | null => {
  const seconds = numeric(v);
  if (seconds === null) return null;
  const d = new Date(seconds * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
export function quotaSnapshots(
  response: unknown,
  accountId: string,
  sourceId: string,
  observedAt: string,
): Quota[] {
  const result = object(response);
  if (!result) throw new QuotaError("额度响应格式不可识别");
  const multi = object(result.rateLimitsByLimitId);
  const legacy = object(result.rateLimits);
  const entries: [string, unknown][] =
    multi && Object.keys(multi).length
      ? Object.entries(multi)
      : legacy
        ? [
            [
              typeof legacy.limitId === "string" ? legacy.limitId : "legacy",
              legacy,
            ],
          ]
        : [];
  if (!entries.length) throw new QuotaError("额度接口未提供可用额度池");
  const snapshots: Quota[] = [];
  for (const [poolKey, raw] of entries.slice(0, 100)) {
    const pool = object(raw);
    if (!pool) continue;
    // No positional assumption that primary=5h, secondary=weekly.
    for (const [slot, value] of Object.entries(pool)) {
      const window = object(value);
      if (
        !["primary", "secondary"].includes(slot) &&
        !(
          window &&
          "usedPercent" in window &&
          ("windowDurationMins" in window || "resetsAt" in window)
        )
      )
        continue;
      const duration = window ? numeric(window.windowDurationMins) : null;
      const windowKey =
        duration !== null && duration > 0
          ? String(duration)
          : "unknown:" + slot;
      const used = window ? numeric(window.usedPercent) : null;
      snapshots.push({
        id:
          "quota:" +
          hash(sourceId + ":" + poolKey + ":" + slot + ":" + observedAt),
        accountId,
        pool: poolKey,
        window: windowKey,
        remainingPercent:
          used === null ? null : Math.max(0, Math.min(100, 100 - used)),
        resetsAt: dateFromSeconds(window?.resetsAt),
        observedAt,
        freshness: "fresh",
        sourceId,
      });
    }
  }
  if (!snapshots.length) throw new QuotaError("额度池未提供可识别窗口");
  return snapshots;
}
