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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { localLoginGuard, quotaIdentity } from "./quota-identity.js";
import { appVersion } from "../core/version.js";
import { Store } from "../core/store.js";
import { hash, type Quota } from "../core/model.js";

import {
  QuotaRpc,
  QuotaError,
  QuotaTimeoutError,
  quotaCommandArgs,
  quotaSnapshots,
  type SpawnQuotaProcess,
} from "./quota-wire.js";
export { quotaCommandArgs, quotaSnapshots } from "./quota-wire.js";
export type { SpawnQuotaProcess } from "./quota-wire.js";
type RefreshResult = { ok: boolean; error?: string };
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as ObjectValue)
    : null;
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
function safeOfficialUsage(value: unknown): ObjectValue | null {
  const numeric = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
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
