// Uses the existing bounded read-only quota protocol; no Store or task imports.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  QuotaRpc,
  quotaCommandArgs,
  quotaSnapshots,
  type SpawnQuotaProcess,
} from "./quota-wire.js";

export function createBalanceReader(
  spawnProcess: SpawnQuotaProcess = (exe, args) =>
    spawn(exe, args, { stdio: "pipe", windowsHide: true, shell: false }),
) {
  let active: QuotaRpc | undefined;
  let flight: Promise<any> | undefined;
  let nextAllowed = 0;
  let failures = 0;
  let closed = false;
  let snapshot = {
    quotas: [] as ReturnType<typeof quotaSnapshots>,
    account: "当前 Codex 账号",
    error: "",
    observedAt: "",
    busy: false,
  };
  const state = () => ({ ...snapshot, nextAllowedAt: nextAllowed });
  async function run() {
    snapshot = { ...snapshot, busy: true };
    nextAllowed = Date.now() + 60_000;
    let rpc: QuotaRpc | undefined;
    try {
      rpc = active = new QuotaRpc(
        spawnProcess(process.env.CODEX_CLI_PATH || "codex", [
          ...quotaCommandArgs,
        ]),
      );
      await rpc.request(
        "initialize",
        { clientInfo: { name: "ai_quota_window", version: "0.1.0" } },
        20_000,
      );
      rpc.notify("initialized", {});
      const before: any = await rpc.request(
        "account/read",
        { refreshToken: false },
        5000,
      );
      if (!before?.account) throw Error("请先在 Codex 登录，再刷新额度");
      const limits = await rpc.request("account/rateLimits/read", null, 5000);
      const after: any = await rpc.request(
        "account/read",
        { refreshToken: false },
        5000,
      );
      if (JSON.stringify(before.account) !== JSON.stringify(after?.account))
        throw Error("查询期间登录账号变化，请重新刷新");
      const observedAt = new Date().toISOString();
      const id =
        typeof before.account.id === "string" ? before.account.id : null;
      const key = createHash("sha256")
        .update(JSON.stringify(before.account))
        .digest("hex");
      const quotas = quotaSnapshots(
        limits,
        id ? "codex:" + key : "unknown:" + key,
        "current-login",
        observedAt,
      );
      snapshot = {
        quotas,
        account: id ? "当前 Codex 账号" : "当前登录 · 身份待确认",
        error: "",
        observedAt,
        busy: false,
      };
      failures = 0;
    } catch {
      failures++;
      snapshot = {
        ...snapshot,
        quotas: [],
        error: "额度读取失败，请检查 Codex 登录与网络后重试。",
        busy: false,
      };
      nextAllowed =
        Date.now() + Math.min(900_000, 60_000 * 2 ** Math.min(failures - 1, 4));
    } finally {
      rpc?.close();
      active = undefined;
    }
    return state();
  }
  return {
    state,
    refresh() {
      if (closed || Date.now() < nextAllowed)
        return flight || Promise.resolve(state());
      if (flight) return flight;
      flight = run().finally(() => {
        flight = undefined;
      });
      return flight;
    },
    async close() {
      closed = true;
      active?.close();
      await flight;
    },
  };
}
