import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../core/store.js";
import {
  readHookQueue,
  hookPreview,
  migrateHookSwitch,
} from "../collector/hooks.js";
test("升级不把旧队列接收许可当作自动安装许可；保留其他偏好", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-hook-migrate-"));
  const store = new Store(dir);
  try {
    store.setSetting("preferences", { hooksEnabled: true, pollMs: 2000 });
    migrateHookSwitch(store);
    assert.deepEqual(store.getSetting("preferences", {}), {
      hooksEnabled: false,
      pollMs: 2000,
    });
    assert.equal(fs.existsSync(path.join(dir, "hook-install.json")), false);
    store.setSetting("preferences", { hooksEnabled: true, pollMs: 2000 });
    migrateHookSwitch(store);
    assert.equal(store.getSetting<any>("preferences", {}).hooksEnabled, true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("可选Hook默认不消费；短时脚本不输出、不保存正文或工具参数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-hook-"));
  const s = new Store(dir);
  try {
    fs.writeFileSync(
      path.join(dir, "hook-enabled.json"),
      JSON.stringify({ enabled: true }),
    );
    const input = {
      hook_event_name: "PermissionRequest",
      session_id: "session",
      turn_id: "turn",
      prompt: "PRIVATE_PROMPT",
      tool_input: { secret: "PRIVATE_TOOL" },
    };
    const result = spawnSync(
      process.execPath,
      ["scripts/hook-receiver.mjs", dir],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    const written = fs.readFileSync(path.join(dir, "hook-queue.jsonl"), "utf8");
    assert.equal(written.includes("PRIVATE"), false);
    assert.equal(readHookQueue(s), 0);
    assert.equal(s.overview().events, 0);
    assert.equal(hookPreview(dir).enabled, false);
    assert.ok(hookPreview(dir).preview.includes("commandWindows"));
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
