import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backup } from "node:sqlite";
import { Store } from "../core/store.js";
import { planHistoryRecovery, recoverHistory } from "../core/history-recovery.js";

type Lifecycle = { pause: () => Promise<void>; resume: () => void };
const messages: Record<string, string> = {
  "conflicting-sources": "备份中的来源身份与当前记录不一致。请保留两份备份并联系支持核对来源。",
  "source-identity-conflict": "备份中的来源身份与当前记录不一致。请保留两份备份并联系支持核对来源。",
  "source-invalid": "无法确认备份的来源身份。请保留备份并联系支持核对。",
  "binding-overlap-conflict": "备份与当前记录的账号关联时间重叠，且指向不同账号。请在账号与设备中核对关联，或保留备份并联系支持。",
  "binding-revocation-conflict": "备份包含已被当前记录撤销的账号关联。为保留你的选择，补回已停止；请保留备份并联系支持。",
  "binding-invalid": "备份中的账号关联时间无法确认。请保留备份并联系支持核对。",
  "conflicting-bindings": "备份与当前记录的账号关联不一致。请保留备份并联系支持核对，当前归属未更改。",
  "conflicting-accounts": "备份中的账号信息与当前记录不一致。请保留备份并联系支持核对账号。",
  "conflicting-annotations": "备份中的备注或收藏与当前记录冲突。请保留备份并联系支持，当前记录未更改。",
  "account-attribution-changed": "补回会改变当前任务的账号归属，已停止操作。请核对账号关联或联系支持。",
  "account-usage-changed": "补回会改变当前用量的账号归属，已停止操作。请核对账号关联或联系支持。",
  "quota-attribution-changed": "补回会改变当前额度的账号归属，已停止操作。请核对账号关联或联系支持。",
  "sharing-state-requires-specialist-migration": "当前记录或备份包含共享连接。为保留授权与撤回状态，暂不能直接补回；请导出支持文件并联系支持。",
  "requires-completed-snapshot": "所选备份尚未完成。请使用产品创建的完整备份，完成后重新选择。",
  "input-changed": "所选备份已经变化。请重新选择并预览。",
  "input-not-file": "无法读取所选备份。请重新选择完整备份。",
  "invalid-database": "所选备份未通过完整性检查。请保留它并选择另一份完整备份。",
  "unsupported-schema": "暂不支持这份备份的版本。请更新 Monitor，或保留备份并联系支持。",
  "preservation-check-failed": "未能确认当前记录完整保留，补回已停止。请保留备份并导出支持文件。",
  "invalid-output": "补回结果未通过检查，当前记录未更改。请导出支持文件并联系支持。",
};
type Failure = { id: string; at: string; phase: "preview" | "apply"; code: string };
// The live connection is never replaced. SQLite commits the complete repair in
// one transaction, or rolls it all back, including on process/power interruption.
export class HistoryRecovery {
  busy = false;
  private previews = new Map<string, { file: string; sha256: string; expires: number }>();
  constructor(private store: Store, private lifecycle: Lifecycle) {}

  // Support details contain only an allowlisted code, never a path, identity,
  // database row, credential or raw exception message.
  reportFailure(error: unknown, phase: Failure["phase"]) {
    const message = error instanceof Error ? error.message : "";
    const key = message.replace(/^history-recovery-/, "");
    const system = (error as { code?: string })?.code;
    const code = Object.hasOwn(messages, key) ? "history-recovery-" + key
      : ["EACCES", "EPERM", "ENOENT", "ENOSPC", "SQLITE_BUSY"].includes(system || "") ? system! : "unknown";
    const failure: Failure = { id: randomUUID(), at: new Date().toISOString(), phase, code };
    try {
      const dir = path.join(this.store.dir, "history-recovery");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "last-failure.json"), JSON.stringify(failure));
    } catch { /* Reporting must not replace the original failure. */ }
    if (Object.hasOwn(messages, key)) return messages[key];
    if (["EACCES", "EPERM"].includes(code)) return "无法访问备份或保存位置。请检查文件权限并确认备份可用后重试。";
    if (code === "ENOSPC") return "保存空间不足。请腾出空间后重新预览，原记录和备份已保留。";
    if (code === "ENOENT") return "找不到所选备份。请刷新备份列表后重新选择。";
    if (code === "SQLITE_BUSY") return "监控记录正被其他操作使用。请稍后重新预览。";
    if (/^(预览已过期|请选择备份|备份路径不允许|已有历史修复|修复期间|修复结果)/.test(message)) return message;
    return "未能完成历史补回，当前记录已保留。请重新预览；仍未成功时导出支持文件并联系支持。";
  }
  supportFailure(): Failure | null {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.store.dir, "history-recovery", "last-failure.json"), "utf8"));
      if (!/^[a-f0-9-]{36}$/.test(v.id) || !Number.isFinite(Date.parse(v.at)) || !["preview", "apply"].includes(v.phase)) return null;
      const valid = v.code === "unknown" || ["EACCES", "EPERM", "ENOENT", "ENOSPC", "SQLITE_BUSY"].includes(v.code) || (String(v.code).startsWith("history-recovery-") && Object.hasOwn(messages, String(v.code).slice(17)));
      return valid ? { id: v.id, at: v.at, phase: v.phase, code: v.code } : null;
    } catch { return null; }
  }

  private legacy(file: unknown) {
    if (typeof file !== "string" || !/^monitor-\d+\.sqlite$/.test(file))
      throw Error("请选择备份列表中的旧监控数据库");
    const dir = fs.realpathSync(path.join(this.store.dir, "backups"));
    const candidate = path.join(dir, file);
    if (fs.lstatSync(candidate).isSymbolicLink() || path.dirname(fs.realpathSync(candidate)) !== dir)
      throw Error("备份路径不允许");
    return candidate;
  }
  private runDir() {
    const dir = path.join(this.store.dir, "history-recovery", randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  private enter() {
    if (this.busy) throw Error("已有历史修复操作进行中");
    this.busy = true;
  }
  async preview(file: unknown) {
    this.enter();
    try {
      const legacy = this.legacy(file), dir = this.runDir();
      const current = path.join(dir, "preview-current.sqlite");
      await backup(this.store.db, current);
      const result = await planHistoryRecovery({ current, legacy, workDir: dir });
      const token = randomUUID();
      for (const [key, value] of this.previews)
        if (value.expires <= Date.now()) this.previews.delete(key);
      if (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(token, { file: file as string, sha256: result.input.legacySha256, expires: Date.now() + 600000 });
      fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify(result, null, 2), { flag: "wx" });
      return { ...result, token, file };
    } finally { this.busy = false; }
  }
  async apply(file: unknown, token: unknown) {
    this.enter();
    let paused = false;
    try {
      const preview = typeof token === "string" ? this.previews.get(token) : undefined;
      if (!preview || preview.file !== file || preview.expires < Date.now())
        throw Error("预览已过期或备份已更换，请重新预览");
      const legacy = this.legacy(file), dir = this.runDir();
      this.previews.delete(token as string);
      paused = true;
      await this.lifecycle.pause();
      const configDir = path.join(dir, "configuration");
      fs.mkdirSync(configDir);
      for (const name of fs.readdirSync(this.store.dir).filter(name => name.endsWith(".json") || ["credential-key.dpapi", "credential-key.local"].includes(name))) {
        const source = path.join(this.store.dir, name);
        if (fs.lstatSync(source).isFile()) fs.copyFileSync(source, path.join(configDir, name), fs.constants.COPYFILE_EXCL);
      }
      // Pause drains current writers before this backup: new records arriving
      // after preview are included, and neither input is ever modified.
      let name = `monitor-${Date.now()}.sqlite`;
      while (fs.existsSync(path.join(this.store.dir, "backups", name))) name = `monitor-${Number(name.slice(8, -7)) + 1}.sqlite`;
      const current = path.join(this.store.dir, "backups", name);
      await backup(this.store.db, current);
      const result = await recoverHistory({ current, legacy, expectedLegacySha256: preview.sha256, outputDir: path.join(dir, "merged"), workDir: dir });
      this.commit(current, result.file);
      this.store.dirty.clear();
      return { ...result, file, backup: name };
    } finally {
      this.busy = false;
      if (paused) this.lifecycle.resume();
    }
  }
  private commit(before: string, merged: string) {
    const db = this.store.db;
    db.prepare("ATTACH DATABASE ? AS recovery_before").run(before);
    try {
      db.prepare("ATTACH DATABASE ? AS recovery_merged").run(merged);
      try {
        this.store.transaction(() => {
          // Verify the *whole* current DB against its frozen consistent backup.
          // Unexpected writers cause a retry, never a lost concurrent update.
          const schema = "SELECT type,name,tbl_name,sql FROM";
          if (db.prepare(`${schema} main.sqlite_master EXCEPT ${schema} recovery_before.sqlite_master LIMIT 1`).get() ||
              db.prepare(`${schema} recovery_before.sqlite_master EXCEPT ${schema} main.sqlite_master LIMIT 1`).get())
            throw Error("修复期间数据库结构发生变化，请重新预览");
          const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").all() as { name: string }[];
          const same = (name: string, target: string) => !db.prepare(`SELECT * FROM main."${name}" EXCEPT SELECT * FROM ${target}."${name}" LIMIT 1`).get() &&
            !db.prepare(`SELECT * FROM ${target}."${name}" EXCEPT SELECT * FROM main."${name}" LIMIT 1`).get();
          for (const { name } of tables) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw Error("不支持的数据库表结构");
            if (!same(name, "recovery_before"))
              throw Error("修复期间数据发生变化，已保留原库，请重新预览");
          }
          db.exec("PRAGMA defer_foreign_keys=ON");
          db.exec(`CREATE TABLE IF NOT EXISTS history_recovery_evidence(table_name TEXT NOT NULL,row_key TEXT NOT NULL,row_hash TEXT NOT NULL,source_sha256 TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(table_name,row_key,row_hash));
CREATE TABLE IF NOT EXISTS history_recovery_inputs(sha256 TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,events INTEGER NOT NULL,sessions INTEGER NOT NULL);`);
          const replaced = ["accounts", "sources", "annotations", "events", "sessions", "usage_points", "quotas", "tombstones", "pending_projection", "history_recovery_evidence", "history_recovery_inputs", "bindings"];
          // Delete child bindings before their accounts, and restore accounts
          // first; keep FK enforcement on throughout the transaction.
          for (const table of [...replaced].reverse()) db.exec(`DELETE FROM main."${table}"`);
          for (const table of replaced) db.exec(`INSERT INTO main."${table}" SELECT * FROM recovery_merged."${table}"`);
          for (const name of new Set([...tables.map(t => t.name), ...replaced]))
            if (!same(name, replaced.includes(name) ? "recovery_merged" : "recovery_before"))
              throw Error("修复结果保护校验失败，已回滚");
          if (db.prepare("PRAGMA main.foreign_key_check").all().length ||
              (db.prepare("PRAGMA main.integrity_check").get() as any).integrity_check !== "ok")
            throw Error("修复结果校验失败，已回滚");
        });
      } finally { db.exec("DETACH DATABASE recovery_merged"); }
    } finally { db.exec("DETACH DATABASE recovery_before"); }
  }
}
