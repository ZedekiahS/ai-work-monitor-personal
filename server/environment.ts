import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import path from "node:path";

type DirectoryState = "readable" | "missing" | "unreadable";

async function directoryState(directory: string): Promise<DirectoryState> {
  try {
    const dir = await opendir(directory);
    try {
      await dir.read();
      return "readable";
    } finally {
      await dir.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
}

async function sessionFiles(directory: string) {
  let visited = 0;
  let opened = false;
  try {
    const dir = await opendir(directory, { recursive: true });
    opened = true;
    for await (const entry of dir) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const file = await open(path.join(entry.parentPath, entry.name), "r");
        await file.close();
        return "found" as const;
      }
      if (++visited >= 2048) return "limited" as const;
    }
    return "empty" as const;
  } catch (error) {
    return !opened && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? ("missing" as const)
      : ("unreadable" as const);
  }
}

export async function inspectSourceDirectories(root: string) {
  const directory = await directoryState(root);
  const [sessions, archived] =
    directory === "readable"
      ? await Promise.all(
          ["sessions", "archived_sessions"].map((name) =>
            sessionFiles(path.join(root, name)),
          ),
        )
      : [null, null];
  return { directory, sessions, archived };
}

// npm installs a command shim on Windows. Launch its Node entry point directly.
function cliCommand(): string[] {
  const configured = process.env.CODEX_CLI_PATH;
  if (process.platform !== "win32") return [configured || "codex"];
  if (configured && !/\.(cmd|ps1)$/i.test(configured)) return [configured];
  const directories = configured
    ? [path.dirname(configured)]
    : (process.env.PATH || "").split(path.delimiter);
  for (const entry of directories.filter(Boolean)) {
    const dir = entry.replace(/^"|"$/g, "");
    const binary = configured || path.join(dir, "codex.exe");
    if (/\.exe$/i.test(binary) && existsSync(binary)) return [binary];
    const npm = path.join(
      dir,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (existsSync(npm)) return [process.execPath, npm];
  }
  return [configured || "codex.exe"];
}

type CliResult = {
  code: number | string | null;
  stdout: string;
  stderr: string;
};
type RunCli = (args: string[], timeout: number) => Promise<CliResult>;
const runCli: RunCli = (args, timeout) => {
  const [command, ...prefix] = cliCommand();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("AIWM_"),
    ),
  );
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...prefix, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        let code: CliResult["code"] = error ? (error.code ?? null) : 0;
        if (error?.killed && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          code = "timeout";
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
};

export async function cliPresence(run = runCli) {
  const result = await run(["--version"], 5_000);
  const version = result.stdout
    .trim()
    .match(/^codex(?:-cli)?\s+(\d+(?:\.\d+)+(?:[-+][\w.+-]+)?)$/i)?.[1];
  if (result.code === 0 && version)
    return { status: "available", version } as const;
  return {
    status: result.code === "ENOENT" ? "missing" : "unavailable",
    version: null,
  } as const;
}

const categories: Record<string, string> = {
  auth: "登录",
  background: "后台服务",
  config: "配置",
  desktop: "桌面应用",
  disk: "磁盘",
  git: "Git",
  install: "安装",
  mcp: "MCP",
  network: "网络",
  runtime: "运行时",
  sandbox: "沙箱",
  security: "安全",
  system: "系统",
  updates: "更新",
};
type CheckStatus = "ok" | "warning" | "fail";
const isStatus = (value: unknown): value is CheckStatus =>
  value === "ok" || value === "warning" || value === "fail";

export async function runCodexDoctor(run = runCli) {
  const help = await run(["doctor", "--help"], 5_000);
  if (help.code === "ENOENT") return { state: "missing" } as const;
  if (help.code === "timeout") return { state: "timeout" } as const;
  const supported =
    /\bUsage:\s*codex(?:\.exe)? doctor\b/i.test(help.stdout) &&
    /--json\b/.test(help.stdout);
  if (
    (help.code === 0 && !supported) ||
    /(?:unrecognized subcommand|unknown command)\s+['"]?doctor\b/i.test(
      help.stderr,
    )
  )
    return { state: "unsupported" } as const;
  if (help.code !== 0) return { state: "failed" } as const;

  const result = await run(["doctor", "--json"], 60_000);
  if (result.code === "timeout") return { state: "timeout" } as const;
  if (result.code !== 0 && result.code !== 1)
    return { state: "failed" } as const;
  try {
    // Only return fixed labels and counts. The raw report can contain local paths and account details.
    const report = JSON.parse(result.stdout) as {
      schemaVersion?: unknown;
      overallStatus?: unknown;
      checks?: unknown;
    };
    if (
      report.schemaVersion !== 1 ||
      !isStatus(report.overallStatus) ||
      !report.checks ||
      typeof report.checks !== "object" ||
      Array.isArray(report.checks)
    )
      return { state: "failed" } as const;
    const counts = { ok: 0, warning: 0, fail: 0 };
    const attention = new Set<string>();
    for (const check of Object.values(report.checks) as {
      status?: unknown;
      category?: unknown;
    }[]) {
      if (!check || !isStatus(check.status))
        return { state: "failed" } as const;
      counts[check.status]++;
      if (check.status !== "ok")
        attention.add(
          typeof check.category === "string" &&
            Object.hasOwn(categories, check.category)
            ? categories[check.category]
            : "其他检查",
        );
    }
    const overall = counts.fail ? "fail" : counts.warning ? "warning" : "ok";
    if (
      !Object.keys(report.checks).length ||
      report.overallStatus !== overall ||
      (result.code === 1 && overall !== "fail")
    )
      return { state: "failed" } as const;
    return {
      state: "complete",
      overall: report.overallStatus,
      counts,
      attention: [...attention],
    } as const;
  } catch {
    return { state: "failed" } as const;
  }
}
