import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, platform, release, arch } from "node:os";
import { DatabaseSync } from "node:sqlite";

type Json = Record<string, unknown>;
const productDir = resolve(process.env.AIWM_DATA_DIR || ".data");
const sourceHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
const outputIndex = process.argv.indexOf("--out");
const outputPath = resolve(
  outputIndex >= 0
    ? process.argv[outputIndex + 1] || "work/diagnostics.json"
    : "work/diagnostics.json",
);
const identifier = /^[A-Za-z_][A-Za-z0-9_./-]{0,100}$/;
const safeKeys = (value: unknown): string[] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
        .filter((k) => identifier.test(k))
        .sort()
    : [];
const kind = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
function objectShape(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object") return kind(value);
  if (Array.isArray(value))
    return {
      type: "array",
      itemShapes: value.slice(0, 2).map((x) => objectShape(x, depth + 1)),
    };
  if (depth >= 4) return { type: "object", keys: safeKeys(value) };
  return Object.fromEntries(
    safeKeys(value).map((k) => [k, objectShape((value as Json)[k], depth + 1)]),
  );
}
function command(
  exe: string,
  args: string[],
  env = process.env,
): string | null {
  const result = spawnSync(exe, args, {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null; // Never print source command errors: they may contain private paths.
}
function powershell(script: string): unknown {
  if (platform() !== "win32") return null;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const output = result.stdout;
  try {
    return output ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}
function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const next = pending.pop()!;
    try {
      for (const item of readdirSync(next, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const file = join(next, item.name);
        if (item.isDirectory()) pending.push(file);
        else if (item.isFile()) result.push(file);
      }
    } catch {
      /* A denied path is not traversed or treated as empty source coverage. */
    }
  }
  return result;
}
function configMetadata(path: string): Json {
  if (!existsSync(path)) return { file: basename(path), exists: false };
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    try {
      const parsed = JSON.parse(text);
      const hooks =
        parsed.hooks && typeof parsed.hooks === "object" ? parsed.hooks : {};
      const allowed = new Set([
        "SessionStart",
        "SessionEnd",
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
        "UserPromptSubmit",
        "SubagentStart",
        "SubagentStop",
        "Stop",
        "Interrupt",
        "PreCompact",
        "PostCompact",
      ]);
      return {
        file: basename(path),
        exists: true,
        eventNames: Object.keys(hooks).filter((k) => allowed.has(k)),
        trusted: "not_verified",
      };
    } catch {
      return {
        file: basename(path),
        exists: true,
        parseStatus: "invalid_json",
        trusted: "not_verified",
      };
    }
  }
  let section = "";
  let inlineSections = 0;
  const featureFlags: Record<string, boolean> = {};
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[+([^\]]+)\]+\s*(?:#.*)?$/);
    if (header) {
      section = header[1]!;
      if (/^hooks(?:\.|$)/.test(section)) inlineSections++;
    }
    const flag =
      section === "features" &&
      line.match(/^\s*(hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (flag) featureFlags[flag[1]!] = flag[2] === "true";
  }
  return {
    file: basename(path),
    exists: true,
    inlineSections,
    featureFlags,
    trusted: "not_verified",
    method: "section_and_boolean_scan_not_full_runtime_config",
  };
}
function sqliteMetadata(path: string): Json {
  const wal = existsSync(path + "-wal");
  const shm = existsSync(path + "-shm");
  // An active WAL without its shared-memory index is not copied or opened.
  if (wal && !shm)
    return {
      file: basename(path),
      wal,
      shm,
      status: "skipped_missing_wal_index",
    };
  let db: DatabaseSync | undefined;
  let stage = "open";
  try {
    db = new DatabaseSync(path, { readOnly: true });
    stage = "transaction";
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    stage = "schema";
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const tables: Json[] = [];
    for (const row of names.slice(0, 60)) {
      const name = String(row.name);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(name)) continue;
      const columns = db
        .prepare('PRAGMA table_info("' + name + '")')
        .all()
        .map((c) => ({ name: c.name, type: c.type }));
      let count: number | null = null;
      // Counts only; no account/session/message values are selected.
      try {
        count = Number(
          db.prepare('SELECT COUNT(*) AS count FROM "' + name + '"').get()
            ?.count ?? 0,
        );
      } catch {
        /* bounded unavailable */
      }
      tables.push({ name, columns, count });
    }
    db.exec("ROLLBACK");
    return {
      file: basename(path),
      wal,
      shm,
      status: "verified_read_only_transaction",
      tables,
    };
  } catch (error) {
    const e = error as { code?: string; errcode?: number; errstr?: string };
    return {
      file: basename(path),
      wal,
      shm,
      status: "unavailable_read_only",
      stage,
      errorCode: e.code ?? null,
      sqliteCode: e.errcode ?? null,
      sqliteStatus: e.errstr ?? null,
    };
  } finally {
    db?.close();
  }
}
function inspectLogs(files: string[]): Json {
  const sorted = files
    .map((file) => {
      try {
        return { file, time: statSync(file).mtimeMs };
      } catch {
        return { file, time: 0 };
      }
    })
    .sort((a, b) => b.time - a.time);
  const types = new Map<string, Json>();
  const metadataVersions = new Set<string>();
  const originators = new Set<string>();
  const observeMetadata = (row: Json) => {
    if (row.type !== "session_meta") return;
    const payload = row.payload as Json | undefined;
    if (
      typeof payload?.cli_version === "string" &&
      /^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(payload.cli_version)
    )
      metadataVersions.add(payload.cli_version);
    if (
      typeof payload?.originator === "string" &&
      /^[A-Za-z_ .-]{1,60}$/.test(payload.originator) &&
      /codex|desktop|vscode|cli/i.test(payload.originator)
    )
      originators.add(payload.originator);
  };
  let scanned = 0;
  let malformed = 0;
  let unreadable = 0;
  // Tail of recently modified sources observes current event formats, never emits content.
  for (const { file } of sorted.slice(0, 40)) {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const size = statSync(file).size;
      const amount = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(amount);
      readSync(fd, buffer, 0, amount, size - amount);
      const lines = buffer.toString("utf8").split("\n");
      if (size > amount) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          scanned++;
          observeMetadata(row);
          const type =
            typeof row.type === "string" && /^[a-z_]{1,60}$/.test(row.type)
              ? row.type
              : "other";
          const payload = row.payload;
          const payloadType =
            typeof payload?.type === "string" &&
            /^[a-z_]{1,70}$/.test(payload.type)
              ? payload.type
              : "none";
          const key = type + ":" + payloadType;
          const previous = types.get(key);
          if (previous) {
            previous.count = Number(previous.count) + 1;
            previous.payloadKeys = [
              ...new Set([
                ...(previous.payloadKeys as string[]),
                ...safeKeys(payload),
              ]),
            ].sort();
            for (const field of [
              "source",
              "thread_source",
              "thread_token_usage",
              "turn_token_usage",
              "rate_limits",
            ]) {
              if (payload && typeof payload === "object" && field in payload) {
                const key = field + "Variants";
                const shape = objectShape(payload[field]);
                const variants = (previous[key] as unknown[]) ?? [];
                if (
                  variants.length < 8 &&
                  !variants.some(
                    (v) => JSON.stringify(v) === JSON.stringify(shape),
                  )
                )
                  variants.push(shape);
                previous[key] = variants;
              }
            }
          } else {
            const structure: Json = {
              type,
              payloadType,
              count: 1,
              rootKeys: safeKeys(row),
              payloadKeys: safeKeys(payload),
            };
            // Only protocol metadata objects, never prompt/content/arguments/output bodies.
            for (const field of [
              "info",
              "rate_limits",
              "source",
              "thread_source",
              "usage",
              "token_usage",
              "thread_token_usage",
              "turn_token_usage",
              "status",
            ]) {
              if (payload && typeof payload === "object" && field in payload)
                structure[field + "Shape"] = objectShape(payload[field]);
            }
            types.set(key, structure);
          }
        } catch {
          malformed++;
        }
      }
      // session_meta is usually only at the beginning; sample its schema separately.
      const prefix = Buffer.alloc(Math.min(size, 64 * 1024));
      readSync(fd, prefix, 0, prefix.length, 0);
      for (const line of prefix.toString("utf8").split("\n").slice(0, 3)) {
        try {
          const row = JSON.parse(line);
          observeMetadata(row);
          if (row.type === "session_meta" && !types.has("session_meta:none")) {
            types.set("session_meta:none", {
              type: "session_meta",
              payloadType: "none",
              count: 1,
              rootKeys: safeKeys(row),
              payloadKeys: safeKeys(row.payload),
              sourceShape: objectShape(row.payload?.source),
            });
          }
        } catch {
          /* partial first chunk is not full-file corruption */
        }
      }
    } catch {
      unreadable++;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return {
    totalFiles: files.length,
    sampledFiles: Math.min(40, files.length),
    scannedRecords: scanned,
    malformedOrPartialSampleLines: malformed,
    unreadableFiles: unreadable,
    sampleMode: "recent_file_tails_plus_session_header",
    metadataVersions: [...metadataVersions],
    originators: [...originators],
    events: [...types.values()],
  };
}
mkdirSync(productDir, { recursive: true });
const sandboxHome = join(productDir, "diagnostic-probe-home");
mkdirSync(sandboxHome, { recursive: true });
const cli = powershell(
  "$c = Get-Command codex -ErrorAction SilentlyContinue; if ($c) { @{path=$c.Source; kind=[string]$c.CommandType} | ConvertTo-Json -Compress }",
) as { path?: string; kind?: string } | null;
const isolatedEnv = { ...process.env, CODEX_HOME: sandboxHome };
const versionOutput = cli?.path
  ? command(cli.path, ["--version"], isolatedEnv)
  : null;
const version =
  versionOutput?.match(/codex(?:-cli)?\s+([0-9][0-9A-Za-z.+-]*)/)?.[1] ?? null;
const processes = powershell(
  "$items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(Codex|ChatGPT|codex-app-server)$' } | ForEach-Object { $v = $null; try { $v = $_.MainModule.FileVersionInfo } catch {}; [PSCustomObject]@{name=$_.ProcessName; productVersion=$v.ProductVersion; fileVersion=$v.FileVersion; image=($_.ProcessName + '.exe')}}); ConvertTo-Json -InputObject $items -Compress",
);
const schemaDirectory = join(productDir, "protocol-schema");
let schemaProbe: Json = { status: "unavailable", methods: {} };
if (cli?.path) {
  mkdirSync(schemaDirectory, { recursive: true });
  const generated = command(
    cli.path,
    [
      "app-server",
      "generate-json-schema",
      "--out",
      schemaDirectory,
      "--experimental",
    ],
    isolatedEnv,
  );
  if (generated !== null) {
    const schemaFiles = walk(schemaDirectory).filter((p) =>
      p.endsWith(".json"),
    );
    const byName = new Map(schemaFiles.map((file) => [basename(file), file]));
    const methods: Record<string, Json> = {};
    for (const [method, filename] of Object.entries({
      "thread/list": "ThreadListParams.json",
      "thread/read": "ThreadReadParams.json",
      "thread/loaded/list": "ThreadLoadedListParams.json",
      "account/read": "GetAccountParams.json",
      "account/rateLimits/read": "GetAccountRateLimitsResponse.json",
      "account/usage/read": "GetAccountTokenUsageResponse.json",
    })) {
      const file = byName.get(filename);
      if (file) {
        const schema = JSON.parse(readFileSync(file, "utf8"));
        methods[method] = {
          schemaAvailable: true,
          properties: Object.keys(schema.properties ?? {}),
          runtimeVerified: false,
        };
      } else
        methods[method] = { schemaAvailable: false, runtimeVerified: false };
    }
    schemaProbe = {
      status: "generated_from_installed_cli_in_isolated_home",
      schemaFiles: schemaFiles.length,
      methods,
      runtimeProbe:
        "not_run_against_user_home_startup_side_effects_not_verified",
      scope: "new_instance_would_not_prove_existing_desktop_runtime_state",
    };
  }
}
const sessionFiles = walk(join(sourceHome, "sessions")).filter((p) =>
  p.endsWith(".jsonl"),
);
const archivedFiles = walk(join(sourceHome, "archived_sessions")).filter((p) =>
  p.endsWith(".jsonl"),
);
const databaseFiles = existsSync(sourceHome)
  ? readdirSync(sourceHome)
      .filter((n) => /^[A-Za-z0-9_.-]+\.sqlite$/.test(n))
      .map((n) => join(sourceHome, n))
  : [];
const report = {
  generatedAt: new Date().toISOString(),
  platform: {
    os: platform(),
    release: release(),
    architecture: arch(),
    node: process.versions.node,
  },
  source: {
    directoryExists: existsSync(sourceHome),
    homeSource: process.env.CODEX_HOME ? "CODEX_HOME" : "default_home",
    writesToSource: false,
  },
  installedCli: {
    version,
    executable: cli?.path ? basename(cli.path) : null,
    path: cli?.path?.replace(homedir(), "~") ?? null,
    versionProbeHome: "isolated_product_data_directory",
  },
  clientProcesses: processes,
  appServer: schemaProbe,
  history: {
    sessions: inspectLogs(sessionFiles),
    archivedSessions: inspectLogs(archivedFiles),
  },
  sourceDatabases: databaseFiles.map(sqliteMetadata),
  hooks: {
    user: [
      configMetadata(join(sourceHome, "hooks.json")),
      configMetadata(join(sourceHome, "config.toml")),
    ],
    project: [
      configMetadata(join(process.cwd(), ".codex", "hooks.json")),
      configMetadata(join(process.cwd(), ".codex", "config.toml")),
    ],
    effectiveRuntimeTrust: "not_verified",
    monitorHookObserved: false,
    pluginManagedLayers: "not_inspected",
    warning: "framework_default_enabled_does_not_prove_hook_trust_or_delivery",
  },
  limitations: [
    "No authenticated runtime RPC was issued.",
    "A new App Server instance cannot certify a different running desktop instance.",
    "Read-only WAL transactions were used; no raw database copies.",
    "Recent structural samples are not an exhaustive historical parser validation.",
    "No source content, identifiers, credentials, or hook commands are included.",
  ],
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    result: "diagnostic_saved",
    output: basename(outputPath),
    codexVersion: version,
    sessionFiles: sessionFiles.length,
    archivedFiles: archivedFiles.length,
    databases: databaseFiles.length,
    runtimeRpcVerified: false,
    hooksTrustVerified: false,
  }),
);
