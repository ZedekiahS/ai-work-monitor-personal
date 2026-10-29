import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const marker = "AI Work Monitor · 本机状态观察";
const events = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
];
export const hookHome = () =>
  path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
export function hookConfiguration(dataDir: string) {
  const script = path.resolve("scripts/hook-receiver.mjs");
  const paths = [process.execPath, script, path.resolve(dataDir)];
  // Commands may be interpreted by a shell. Reject ambiguous path expansion.
  if (paths.some((p) => /["\r\n%$`!]/.test(p)))
    throw Error("安装路径含不支持的命令字符，请使用普通路径安装监控台");
  const command = paths.map((p) => `"${p}"`).join(" ");
  return {
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: "command",
                command,
                commandWindows: command,
                timeout: 2,
                statusMessage: marker,
              },
            ],
          },
        ],
      ]),
    ),
  };
}
function read(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw Error("Hook 配置不是普通文件或超过 1 MiB，请检查后重试");
    return fs.readFileSync(file, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function parse(raw: string | null) {
  const value = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    (value.hooks !== undefined &&
      (!value.hooks ||
        Array.isArray(value.hooks) ||
        typeof value.hooks !== "object"))
  )
    throw Error("现有 hooks.json 格式无法安全合并，未覆盖原文件");
  for (const groups of Object.values(value.hooks || {}) as any[]) {
    if (
      !Array.isArray(groups) ||
      groups.some((g) => !g || !Array.isArray(g.hooks))
    )
      throw Error("现有 Hook 条目格式无法安全合并，未覆盖原文件");
  }
  return value;
}
function atomic(file: string, content: string) {
  const temp = file + ".aiwm-" + randomUUID();
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function hookGate(dataDir: string, enabled: boolean) {
  atomic(
    path.join(dataDir, "hook-enabled.json"),
    JSON.stringify({ enabled, since: new Date().toISOString() }),
  );
}
/** Edits only exact handler definitions previously written by this installation. */
export function configureHooks(
  dataDir: string,
  enabled: boolean,
  home = hookHome(),
) {
  const manifestFile = path.join(dataDir, "hook-install.json");
  const previous = JSON.parse(read(manifestFile) || "null");
  const file = previous?.file || path.join(home, "hooks.json");
  if (!path.isAbsolute(file) || path.basename(file) !== "hooks.json")
    throw Error("Hook 安装记录无效");
  if (!enabled) hookGate(dataDir, false); // Even cached host definitions become inert immediately.
  if (!enabled && !previous) return { configured: false, cleanupError: null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink())
    throw Error("Hook 配置目录不能是符号链接");
  const lock = file + ".aiwm.lock";
  const fd = fs.openSync(lock, "wx");
  try {
    const before = read(file);
    const doc = parse(before);
    const owned = previous?.handlers || [];
    for (const [event, groups] of Object.entries(doc.hooks || {}) as [
      string,
      any[],
    ][]) {
      doc.hooks[event] = groups.flatMap((group) => {
        const remaining = group.hooks.filter(
          (h: any) =>
            !owned.some(
              (o: any) => o.event === event && isDeepStrictEqual(o.handler, h),
            ),
        );
        return remaining.length === group.hooks.length
          ? [group]
          : remaining.length
            ? [{ ...group, hooks: remaining }]
            : [];
      });
      if (groups.length && !doc.hooks[event].length) delete doc.hooks[event];
    }
    // Changed definitions belong to the user; never silently overwrite or remove them.
    const conflict = Object.values(doc.hooks || {}).some((groups: any) =>
      groups.some((g: any) =>
        g.hooks.some((h: any) => h.statusMessage === marker),
      ),
    );
    if (enabled && conflict)
      throw Error(
        "本产品 Hook 条目已被手动修改或来自另一安装，请检查详情后重试；原条目保留",
      );
    const desired = hookConfiguration(dataDir);
    if (enabled) {
      doc.hooks ??= {};
      for (const [event, groups] of Object.entries(desired.hooks))
        doc.hooks[event] = [...(doc.hooks[event] || []), ...groups];
    }
    const after = JSON.stringify(doc, null, 2) + "\n";
    if (before !== null && !isDeepStrictEqual(parse(before), doc)) {
      const backups = path.join(dataDir, "hook-backups");
      fs.mkdirSync(backups, { recursive: true });
      fs.writeFileSync(
        path.join(backups, `hooks-${Date.now()}-${randomUUID()}.json`),
        before,
        { flag: "wx", mode: 0o600 },
      );
    }
    const handlers = Object.entries(desired.hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) => g.hooks.map((handler) => ({ event, handler }))),
    );
    // Persist ownership before the external write so an interrupted install can be removed.
    if (enabled)
      atomic(
        manifestFile,
        JSON.stringify({ file, handlers: [...owned, ...handlers] }),
      );
    if (read(file) !== before)
      throw Error("Hook 配置同时被其他程序修改，请重试；未覆盖新内容");
    if (before === null || !isDeepStrictEqual(parse(before), doc))
      atomic(file, after);
    if (enabled) {
      atomic(manifestFile, JSON.stringify({ file, handlers }));
      hookGate(dataDir, true);
    }
    return {
      configured: enabled,
      cleanupError: conflict
        ? "已停止接收；手动改过的 Hook 条目已保留，请在详情中检查"
        : null,
    };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
export function installationStatus(
  dataDir: string,
  enabled: boolean,
  lastEvent?: string,
) {
  try {
    const manifest = JSON.parse(
      read(path.join(dataDir, "hook-install.json")) || "null",
    );
    const gate = JSON.parse(
      read(path.join(dataDir, "hook-enabled.json")) || "null",
    );
    const config = manifest ? parse(read(manifest.file)) : {};
    const configured =
      !!manifest &&
      manifest.handlers.every((o: any) =>
        (config.hooks?.[o.event] || []).some((g: any) =>
          g.hooks.some((h: any) => isDeepStrictEqual(h, o.handler)),
        ),
      );
    const receiving = enabled && gate?.enabled && configured;
    const missingEvents = configured
      ? events.filter(
          (event) => !manifest.handlers.some((o: any) => o.event === event),
        )
      : [];
    return {
      configured,
      updateAvailable: missingEvents.length > 0,
      missingEvents,
      status: !enabled
        ? "off"
        : !receiving
          ? "needs_setup"
          : lastEvent && lastEvent >= gate.since
            ? "observed"
            : "awaiting_event",
      lastEvent: receiving ? lastEvent || null : null,
      configPath: manifest?.file || path.join(hookHome(), "hooks.json"),
    };
  } catch {
    return {
      configured: false,
      status: enabled ? "needs_setup" : "off",
      lastEvent: null,
    };
  }
}
