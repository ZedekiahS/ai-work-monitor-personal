import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.js";
import { HistoryRecovery } from "../server/history-recovery.js";

test("history conflicts have actionable customer messages and retain only safe support details", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-message-"));
  const store = new Store(dir);
  try {
    const service = new HistoryRecovery(store, { pause: async () => {}, resume: () => {} });
    for (const [code, expected] of [
      ["conflicting-sources", /来源身份.*联系支持/],
      ["binding-overlap-conflict", /账号关联.*重叠/],
      ["sharing-state-requires-specialist-migration", /共享.*联系支持/],
      ["requires-completed-snapshot", /备份.*完成/],
    ]) {
      const message = service.reportFailure(Error("history-recovery-" + code), "preview");
      assert.match(message, expected);
      assert.doesNotMatch(message, /history-recovery|conflicting-/);
      assert.equal(service.supportFailure()?.code, "history-recovery-" + code);
    }
    const privateError = Object.assign(Error("private session secret C:\\private\\data"), { code: "EACCES" });
    assert.match(service.reportFailure(privateError, "apply"), /访问.*备份/);
    const disk = fs.readFileSync(path.join(dir, "history-recovery", "last-failure.json"), "utf8");
    assert.doesNotMatch(disk, /secret|private|data/);
    assert.equal(service.supportFailure()?.code, "EACCES");
    assert.match(service.reportFailure(Error("unrecognized secret"), "apply"), /支持/);
    assert.equal(service.supportFailure()?.code, "unknown");
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
