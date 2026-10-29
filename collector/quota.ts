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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { localLoginGuard, quotaIdentity } from "./quota-identity.js";
import { appVersion } from "../core/version.js";
import { Store } from "../core/store.js";
import { hash, type Quota } from "../core/model.js";

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
type RefreshResult = { ok: boolean; error?: string };
type RefreshState = {
  nextAllowedAt: number;
  failures: number;
  lastSuccessAt?: string;
  lastError?: string;
  sourceId?: string;
  accountId?: string;
  attempts?: number;
  lastErrorStage?: string;
};
class QuotaError extends Error {}
class QuotaTimeoutError extends QuotaError {
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

class QuotaRpc {
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
function safeOfficialUsage(value: unknown): ObjectValue | null {
  const v = object(value);
  const summary = object(v?.summary);
  if (!summary) return null;
  const allowed = [
    "lifetimeTokens",
    "currentStreakDays",
    "longestStreakDays",
    "longestRunningTurnSec",
    "totalSessions",
    "totalTurns",
  ];
  const selected = Object.fromEntries(
    allowed.filter((k) => k in summary).map((k) => [k, numeric(summary[k])]),
  );
  const days = Array.isArray(v?.dailyUsageBuckets)
    ? v.dailyUsageBuckets.slice(0, 3660).flatMap((bucket) => {
        const b = object(bucket);
        return b &&
          typeof b.startDate === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(b.startDate)
          ? [{ startDate: b.startDate, tokens: numeric(b.tokens) }]
          : [];
      })
    : null;
  return { summary: selected, dailyUsageBuckets: days };
}
export function createQuotaRefresher(
  options: {
    spawnProcess?: SpawnQuotaProcess;
    now?: () => number;
    timeoutMs?: number;
    initializeTimeoutMs?: number;
    totalTimeoutMs?: number;
    identityGuard?: () => string | null;
  } = {},
) {
  const flights = new WeakMap<Store, Promise<RefreshResult>>();
  const probes = new WeakMap<Store, QuotaRpc>();
  const now = options.now ?? Date.now;
  const guard =
    options.identityGuard ??
    (options.spawnProcess ? () => null : localLoginGuard);
  const spawnProcess: SpawnQuotaProcess =
    options.spawnProcess ??
    ((exe, args) =>
      spawn(exe, args, { stdio: "pipe", windowsHide: true, shell: false }));
  async function run(store: Store): Promise<RefreshResult> {
    const state = store.getSetting<RefreshState>("quotaRefresh", {
      nextAllowedAt: 0,
      failures: 0,
    });
    const started = now();
    if (started < state.nextAllowedAt)
      return {
        ok: false,
        error:
          "刷新已节流，请在 " +
          Math.ceil((state.nextAllowedAt - started) / 1000) +
          " 秒后重试",
      };
    store.setSetting("quotaRefresh", {
      ...state,
      nextAllowedAt: started + 60_000,
    });
    const displaySourceId =
      "quota-probe:" +
      hash(
        [
          store.getSetting("deviceId", "local"),
          path.resolve(
            process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
          ),
          process.env.CODEX_CLI_PATH || "codex",
        ].join("|"),
      ).slice(0, 24);
    let sourceId = displaySourceId;
    const probeRunId = randomUUID();
    // One retry for a transient timeout, with a shared wall-clock budget. Each
    // attempt reads identity again and owns only its newly spawned subprocess.
    const deadline = performance.now() + (options.totalTimeoutMs ?? 30_000);
    for (let attempt = 1; ; attempt++) {
      let rpc: QuotaRpc | undefined;
      try {
        rpc = new QuotaRpc(
          spawnProcess(process.env.CODEX_CLI_PATH || "codex", [
            ...quotaCommandArgs,
          ]),
        );
        probes.set(store, rpc);
        const request = (method: string, params: unknown, timeout: number) => {
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            return Promise.reject(new QuotaTimeoutError(method));
          return rpc!.request(method, params, Math.min(timeout, remaining));
        };
        await request(
          "initialize",
          { clientInfo: { name: "ai_work_monitor", version: appVersion } },
          options.initializeTimeoutMs ?? 20_000,
        );
        rpc.notify("initialized", {});
        const beforeGuard = guard();
        const accountResponse = object(
          await request(
            "account/read",
            { refreshToken: false },
            options.timeoutMs ?? 5000,
          ),
        );
        const account = object(accountResponse?.account);
        if (!account)
          throw new QuotaError(
            "Codex 未返回登录账号；请在原客户端处理登录后再查询",
          );
        const id =
          typeof account.id === "string" && account.id.length > 0
            ? account.id
            : null;
        const limits = await request(
          "account/rateLimits/read",
          null,
          options.timeoutMs ?? 5000,
        );
        const after = object(
          await request(
            "account/read",
            { refreshToken: false },
            options.timeoutMs ?? 5000,
          ),
        );
        if (
          (object(after?.account)?.id ?? null) !== id ||
          (!id && beforeGuard !== guard())
        )
          throw new QuotaError("登录状态在查询期间变化，未归属或保存此额度");
        const identity = quotaIdentity(store, displaySourceId, id, beforeGuard);
        sourceId = identity.sourceId;
        const accountId = identity.accountId;
        const observedAt = new Date(now()).toISOString();
        const snapshots = quotaSnapshots(
          limits,
          accountId,
          sourceId,
          observedAt,
        ).map((q) => ({
          ...q,
          displaySourceId,
          probeRunId,
          identityEvidence: id
            ? ("confirmed" as const)
            : ("unconfirmed" as const),
        }));
        let officialUsage: ObjectValue | null = null;
        try {
          officialUsage = safeOfficialUsage(
            await request(
              "account/usage/read",
              null,
              options.timeoutMs ?? 5000,
            ),
          );
        } catch {
          /* Optional endpoint; quota remains usable. */
        }
        store.transaction(() => {
          store.db
            .prepare("INSERT OR IGNORE INTO accounts VALUES(?,?,?,?)")
            .run(
              accountId,
              id
                ? "Codex 账号 " + accountId.slice(-6)
                : "未确认账号（独立额度查询）",
              "codex",
              id ? "account_rpc_stable_id" : "account_rpc_unbound",
            );
          for (const snapshot of snapshots) store.addQuota(snapshot);
          if (officialUsage)
            store.setSetting("officialUsage:" + accountId, {
              ...officialUsage,
              accountId,
              sourceId,
              observedAt,
              scope: "official-account-total-not-local-task-sum",
            });
          store.setSetting("quotaRefresh", {
            nextAllowedAt: now() + 60_000,
            failures: 0,
            lastSuccessAt: observedAt,
            sourceId,
            accountId,
            attempts: attempt,
          });
          store.audit("quota-read", sourceId);
        });
        return { ok: true };
      } catch (error) {
        if (
          error instanceof QuotaTimeoutError &&
          attempt === 1 &&
          performance.now() < deadline
        )
          continue;
        // Errors generated locally only. RPC errors, stderr and account payloads are never retained.
        const reason =
          error instanceof QuotaError
            ? error.message
            : "Codex 额度查询失败（未记录可能包含凭据的错误原文）";
        const failures = Math.min(10, state.failures + 1);
        store.setSetting("quotaRefresh", {
          ...state,
          failures,
          nextAllowedAt:
            now() + Math.min(15 * 60_000, 60_000 * 2 ** (failures - 1)),
          lastError: reason,
          lastErrorStage:
            error instanceof QuotaTimeoutError ? error.stage : undefined,
          attempts: attempt,
        });
        return { ok: false, error: reason };
      } finally {
        rpc?.close();
        probes.delete(store);
      }
    }
  }
  const refresh = (store: Store): Promise<RefreshResult> => {
    const existing = flights.get(store);
    if (existing) return existing;
    const promise = run(store).finally(() => flights.delete(store));
    flights.set(store, promise);
    return promise;
  };
  return Object.assign(refresh, {
    cancel: async (store: Store) => {
      probes.get(store)?.close();
      await flights.get(store);
    },
  });
}
export const refreshQuota = createQuotaRefresher();
