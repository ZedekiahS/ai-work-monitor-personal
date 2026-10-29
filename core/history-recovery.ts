import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "./store.js";
import { hash } from "./model.js";

type Row = Record<string, any>;
export interface RecoveryOptions {
  current: string;
  legacy: string;
  workDir?: string;
  expectedCurrentSha256?: string;
  expectedLegacySha256?: string;
}
export interface HistoryRecoverySummary {
  version: 1;
  input: {
    currentSha256: string;
    legacySha256: string;
    currentSchema: number;
    legacySchema: number;
  };
  counts: {
    eventsAdded: number;
    eventsArchived: number;
    metadataDuplicatesArchived: number;
    quotasAdded: number;
    quotasArchived: number;
    sourcesAdded: number;
    accountsAdded: number;
    annotationsAdded: number;
    bindingsAdded: number;
    tombstonesAdded: number;
    sessionsRecovered: number;
  };
  result: {
    sessions: number;
    events: number;
    usagePoints: number;
    integrity: "ok";
  };
  preserved: {
    currentEvents: boolean;
    currentSettings: boolean;
    currentCursors: boolean;
    currentSync: boolean;
    currentAccountAttribution: boolean;
    currentAccountUsage: boolean;
    currentQuotaAttribution: boolean;
    inputHashes: boolean;
  };
  idempotent: boolean;
}
function digest(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function tableExists(db: DatabaseSync, table: string) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
}
function count(db: DatabaseSync, table: string) {
  return tableExists(db, table)
    ? Number((db.prepare(`SELECT count(*) n FROM "${table}"`).get() as Row).n)
    : 0;
}
function rows(db: DatabaseSync, table: string): Row[] {
  return tableExists(db, table)
    ? (db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[])
    : [];
}
function empty(value: unknown): boolean {
  return (
    value == null ||
    value === false ||
    value === "" ||
    (Array.isArray(value) && !value.length) ||
    (typeof value === "object" && !Object.keys(value as object).length)
  );
}
const sharedSettings = [
  "hubPair",
  "hubPairs",
  "productIdentities",
  "pendingRegistrations",
  "pendingRevocations",
  "pendingErases",
  "completedInvitations",
  "activeHubPair",
];
function rejectSharing(db: DatabaseSync) {
  for (const r of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Row[]) {
    if (
      (/^(sync_|event_grants$)/.test(r.name) ||
        ["grants", "outbox"].includes(r.name)) &&
      count(db, r.name)
    )
      throw Error(
        "history-recovery-sharing-state-requires-specialist-migration",
      );
  }
  // Encrypted pairing data is intentionally not decrypted here. Any populated
  // sharing state needs its own coordinated migration, even if no grant rows
  // have reached the local database yet.
  for (const key of sharedSettings) {
    const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
      | Row
      | undefined;
    if (r && !empty(JSON.parse(r.value)))
      throw Error(
        "history-recovery-sharing-state-requires-specialist-migration",
      );
  }
}
function validateSnapshot(file: string): string {
  const resolved = fs.realpathSync(file);
  if (!fs.statSync(resolved).isFile())
    throw Error("history-recovery-input-not-file");
  for (const suffix of ["-wal", "-journal"])
    if (
      fs.existsSync(resolved + suffix) &&
      fs.statSync(resolved + suffix).size > 0
    )
      throw Error("history-recovery-requires-completed-snapshot");
  return resolved;
}
function inspect(db: DatabaseSync) {
  if (
    (db.prepare("PRAGMA integrity_check").get() as Row).integrity_check !== "ok"
  )
    throw Error("history-recovery-invalid-database");
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as Row).user_version,
  );
  if (![2, 3].includes(version))
    throw Error("history-recovery-unsupported-schema");
  for (const table of [
    "events",
    "sessions",
    "settings",
    "cursors",
    "tombstones",
    "annotations",
    "accounts",
    "sources",
    "quotas",
    "bindings",
  ])
    if (!tableExists(db, table))
      throw Error("history-recovery-invalid-database");
  return version;
}
function metadataKey(row: Row): string | undefined {
  const e = JSON.parse(row.json);
  if (
    !String(e.id).startsWith("dbmeta:") ||
    e.kind !== "session_meta" ||
    e.data?.sourceKind !== "database" ||
    !e.data?.metadataOnly
  )
    return;
  // Only normalize a project ID whose exact derivation can be proved from the
  // stored original path. This is provenance equality, never account merging.
  const projectPath = e.data.projectPath;
  const expected = projectPath
    ? "project:" + hash(e.environmentId + ":" + path.normalize(projectPath))
    : "unknown";
  if (e.projectId !== expected) return;
  const {
    id,
    deviceId,
    environmentId,
    sourceId,
    projectId,
    observedAt,
    receivedAt,
    ...rest
  } = e;
  return canonical(rest);
}
function assertSameRows(
  current: DatabaseSync,
  merged: DatabaseSync,
  table: string,
  keys: string[],
  skip?: (r: Row) => boolean,
) {
  if (!tableExists(current, table)) return true;
  const get = merged.prepare(
    `SELECT * FROM "${table}" WHERE ${keys.map((k) => `"${k}"=?`).join(" AND ")}`,
  );
  for (const row of current
    .prepare(`SELECT * FROM "${table}"`)
    .iterate() as Iterable<Row>) {
    if (skip?.(row)) continue;
    const after = get.get(...keys.map((k) => row[k])) as Row | undefined;
    if (
      !after ||
      Object.keys(row).some((k) => canonical(row[k]) !== canonical(after[k]))
    )
      return false;
  }
  return true;
}
function bindingInterval(row: Row) {
  const from = typeof row.from_at === "string" ? Date.parse(row.from_at) : NaN;
  const to = typeof row.to_at === "string" ? Date.parse(row.to_at) : NaN;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    ![0, 1].includes(row.revoked) ||
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.source_id !== "string" ||
    !row.source_id ||
    typeof row.account_id !== "string" ||
    !row.account_id
  )
    throw Error("history-recovery-binding-invalid");
  return { from, to };
}
function overlapsBinding(a: Row, b: Row) {
  const x = bindingInterval(a),
    y = bindingInterval(b);
  return a.source_id === b.source_id && x.from < y.to && y.from < x.to;
}
function sourceIdentity(row: Row) {
  let value: any;
  try {
    value = JSON.parse(row.json);
  } catch {
    throw Error("history-recovery-source-invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.id !== row.id ||
    ["id", "kind", "environmentId", "pathLabel"].some(
      (k) => typeof value[k] !== "string" || !value[k],
    )
  )
    throw Error("history-recovery-source-invalid");
  // Display labels and collector observations can change between two consistent
  // backups. Keep the current complete row; archive the old row as evidence.
  // Unknown fields remain identity-relevant so future schema additions fail closed.
  const { label, health, lastScanAt, errorCount, capabilities, ...identity } =
    value;
  return identity;
}
function sourceConfiguration(db: DatabaseSync, id: string) {
  const row = db
    .prepare("SELECT value FROM settings WHERE key='sourceConfigs'")
    .get() as Row | undefined;
  if (!row) return undefined;
  let configs: any;
  try {
    configs = JSON.parse(row.value);
  } catch {
    throw Error("history-recovery-source-invalid");
  }
  if (!Array.isArray(configs)) throw Error("history-recovery-source-invalid");
  const matches = configs.filter((c) => c && c.id === id);
  if (matches.length > 1) throw Error("history-recovery-source-invalid");
  if (!matches.length) return undefined;
  const { label, ...identity } = matches[0];
  return identity;
}
function assertAccountAttribution(
  current: DatabaseSync,
  merged: DatabaseSync,
  tombstones: Set<string>,
) {
  const before = Object.create(Store.prototype) as Store,
    after = Object.create(Store.prototype) as Store;
  before.db = current;
  after.db = merged;
  for (const row of rows(current, "sessions")) {
    if (tombstones.has(row.id)) continue;
    const result = merged
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(row.id) as Row | undefined;
    if (
      !result ||
      before.effectiveAccount(row) !== after.effectiveAccount(result)
    )
      throw Error("history-recovery-account-attribution-changed");
  }
  const manual = (db: DatabaseSync, source: string | null, at: string) =>
    (
      db
        .prepare(
          "SELECT account_id FROM bindings WHERE source_id=? AND revoked=0 AND evidence='manual' AND from_at<=? AND to_at>? ORDER BY from_at DESC LIMIT 1",
        )
        .get(source, at, at) as Row | undefined
    )?.account_id ?? null;
  // Match production wire attribution: creator identity is not a billing
  // identity; otherwise a measured event account precedes manual mapping.
  const accountForUsage = (db: DatabaseSync, row: Row) => {
    const e = JSON.parse(row.event_json);
    const mapped = manual(db, e.sourceId ?? null, e.occurredAt);
    return [
      "session_creator_only",
      "database_creator_account_id",
      "session_header",
    ].includes(e.data?.accountEvidence)
      ? mapped
      : (e.accountId ?? mapped);
  };
  const totalsBefore = new Map<string | null, Record<string, number>>(),
    totalsAfter = new Map<string | null, Record<string, number>>();
  const add = (
    totals: Map<string | null, Record<string, number>>,
    account: string | null,
    value: Row,
  ) => {
    const sum = totals.get(account) ?? {};
    for (const [key, n] of Object.entries(value)) {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
        throw Error("history-recovery-invalid-database");
      sum[key] = (sum[key] ?? 0) + n;
    }
    totals.set(account, sum);
  };
  // Scope this invariant to *current contributions*. Restored missing history
  // legitimately increases final totals; it must not reassign existing usage.
  for (const row of rows(current, "usage_points")) {
    if (tombstones.has(row.session_id)) continue;
    const oldAccount = accountForUsage(current, row),
      newAccount = accountForUsage(merged, row);
    if (oldAccount !== newAccount)
      throw Error("history-recovery-account-usage-changed");
    const usage = JSON.parse(row.usage);
    add(totalsBefore, oldAccount, usage);
    add(totalsAfter, newAccount, usage);
  }
  if (canonical([...totalsBefore]) !== canonical([...totalsAfter]))
    throw Error("history-recovery-account-usage-changed");
  // Quota grouping uses manual observation-time binding ahead of the saved
  // account. Protect every current observation, not only today's visible card.
  for (const row of rows(current, "quotas")) {
    const q = JSON.parse(row.json);
    if (
      (manual(current, q.sourceId ?? null, row.observed_at) ??
        q.accountId ??
        null) !==
      (manual(merged, q.sourceId ?? null, row.observed_at) ??
        q.accountId ??
        null)
    )
      throw Error("history-recovery-quota-attribution-changed");
  }
  return {
    currentAccountAttribution: true,
    currentAccountUsage: true,
    currentQuotaAttribution: true,
  };
}
function removeScratch(dir: string, parent: string) {
  const absolute = path.resolve(dir),
    base = path.resolve(parent);
  if (
    path.dirname(absolute) !== base ||
    !path.basename(absolute).startsWith("aiwm-history-recovery-")
  )
    throw Error("history-recovery-invalid-scratch");
  fs.rmSync(absolute, { recursive: true, force: true });
}
async function run(
  options: RecoveryOptions,
  outputDir?: string,
): Promise<HistoryRecoverySummary & { file?: string }> {
  const currentPath = validateSnapshot(options.current),
    legacyPath = validateSnapshot(options.legacy);
  const currentSha256 = digest(currentPath),
    legacySha256 = digest(legacyPath);
  if (
    (options.expectedCurrentSha256 &&
      options.expectedCurrentSha256 !== currentSha256) ||
    (options.expectedLegacySha256 &&
      options.expectedLegacySha256 !== legacySha256)
  )
    throw Error("history-recovery-input-changed");
  if (outputDir && fs.existsSync(outputDir))
    throw Error("history-recovery-output-already-exists");
  const parent = path.resolve(options.workDir ?? os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, "aiwm-history-recovery-"));
  let current: DatabaseSync | undefined,
    legacy: DatabaseSync | undefined,
    merged: DatabaseSync | undefined;
  try {
    const c = path.join(scratch, "current.sqlite"),
      l = path.join(scratch, "legacy.sqlite");
    fs.copyFileSync(currentPath, c);
    fs.copyFileSync(legacyPath, l);
    if (
      digest(c) !== currentSha256 ||
      digest(l) !== legacySha256 ||
      digest(currentPath) !== currentSha256 ||
      digest(legacyPath) !== legacySha256
    )
      throw Error("history-recovery-input-changed");
    // SQLite may create SHM even for a read-only WAL-mode database. It only sees
    // the private copies; the caller's completed snapshots are never opened.
    current = new DatabaseSync(c, { readOnly: true });
    legacy = new DatabaseSync(l, { readOnly: true });
    const currentSchema = inspect(current),
      legacySchema = inspect(legacy);
    rejectSharing(current);
    rejectSharing(legacy);
    const resultDir = outputDir
      ? path.resolve(outputDir)
      : path.join(scratch, "result");
    fs.mkdirSync(resultDir, { recursive: false });
    const file = path.join(resultDir, "monitor.sqlite");
    await backup(current, file);
    merged = new DatabaseSync(file);
    merged.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
    // Reuse the production migration/projection without constructing Credentials,
    // decrypting existing settings, generating a key or starting a collector.
    const projector = Object.create(Store.prototype) as Store;
    Object.assign(projector, {
      db: merged,
      file,
      dir: resultDir,
      dirty: new Set<string>(),
    });
    projector.migrate();
    merged.exec(`CREATE TABLE IF NOT EXISTS history_recovery_evidence(table_name TEXT NOT NULL,row_key TEXT NOT NULL,row_hash TEXT NOT NULL,source_sha256 TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(table_name,row_key,row_hash));
CREATE TABLE IF NOT EXISTS history_recovery_inputs(sha256 TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,events INTEGER NOT NULL,sessions INTEGER NOT NULL);`);
    const beforeEvidence = count(merged, "history_recovery_evidence");
    const alreadyImported = !!merged
      .prepare("SELECT 1 FROM history_recovery_inputs WHERE sha256=?")
      .get(legacySha256);
    const counts: HistoryRecoverySummary["counts"] = {
      eventsAdded: 0,
      eventsArchived: 0,
      metadataDuplicatesArchived: 0,
      quotasAdded: 0,
      quotasArchived: 0,
      sourcesAdded: 0,
      accountsAdded: 0,
      annotationsAdded: 0,
      bindingsAdded: 0,
      tombstonesAdded: 0,
      sessionsRecovered: 0,
    };
    const archiveStmt = merged.prepare(
      "INSERT OR IGNORE INTO history_recovery_evidence VALUES(?,?,?,?,?)",
    );
    const archive = (table: string, row: Row, sourceHash = legacySha256) => {
      const serialized = canonical(row);
      return Number(
        archiveStmt.run(
          table,
          String(
            row.id ?? row.session_id ?? row.key ?? row.path ?? hash(serialized),
          ),
          hash(serialized),
          sourceHash,
          serialized,
        ).changes,
      );
    };
    const tombstones = new Set<string>(
      [...rows(current, "tombstones"), ...rows(legacy, "tombstones")].map(
        (r) => r.session_id,
      ),
    );
    const changedSessions = new Set<string>();
    const currentBindings = rows(current, "bindings");
    for (const row of [...currentBindings, ...rows(legacy, "bindings")])
      bindingInterval(row);
    const insertRaw = (table: string, row: Row) => {
      const columns = Object.keys(row);
      return merged!
        .prepare(
          `INSERT INTO "${table}"(${columns.map((k) => `"${k}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        )
        .run(...columns.map((k) => row[k]));
    };
    merged.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows(legacy, "tombstones")) {
        if (
          !merged
            .prepare("SELECT 1 FROM tombstones WHERE session_id=?")
            .get(row.session_id)
        ) {
          insertRaw("tombstones", row);
          counts.tombstonesAdded++;
        } else archive("tombstones", row);
      }
      for (const id of tombstones) {
        for (const table of [
          "events",
          "sessions",
          "usage_points",
          "annotations",
          "pending_projection",
        ]) {
          const key = table === "sessions" ? "id" : "session_id";
          for (const row of merged
            .prepare(`SELECT * FROM "${table}" WHERE "${key}"=?`)
            .all(id) as Row[])
            archive(table, row, currentSha256);
          merged.prepare(`DELETE FROM "${table}" WHERE "${key}"=?`).run(id);
        }
      }
      for (const [table, key, counter] of [
        ["accounts", "id", "accountsAdded"],
        ["sources", "id", "sourcesAdded"],
        ["annotations", "session_id", "annotationsAdded"],
        ["bindings", "id", "bindingsAdded"],
      ] as const) {
        const get = merged.prepare(`SELECT * FROM "${table}" WHERE "${key}"=?`);
        for (const row of rows(legacy, table)) {
          if (table === "annotations" && tombstones.has(row.session_id)) {
            archive(table, row);
            continue;
          }
          const existing = get.get(row[key]) as Row | undefined;
          if (table === "sources") {
            sourceIdentity(row);
            const oldConfig = sourceConfiguration(legacy, row.id),
              currentConfig = sourceConfiguration(current, row.id);
            // A configured source may not have produced its first observation
            // yet. That does not make its identity available for an old row.
            if (
              oldConfig &&
              currentConfig &&
              canonical(oldConfig) !== canonical(currentConfig)
            )
              throw Error("history-recovery-source-identity-conflict");
            const incoming = JSON.parse(row.json);
            if (
              currentConfig &&
              ["kind", "environmentId"].some(
                (k) =>
                  currentConfig[k] !== undefined &&
                  currentConfig[k] !== incoming[k],
              )
            )
              throw Error("history-recovery-source-identity-conflict");
          }
          if (existing) {
            if (table === "sources") {
              if (
                canonical(sourceIdentity(existing)) !==
                canonical(sourceIdentity(row))
              )
                throw Error("history-recovery-source-identity-conflict");
              if (canonical(existing) !== canonical(row))
                archive("sources", row);
              continue;
            }
            if (canonical(existing) !== canonical(row))
              throw Error("history-recovery-conflicting-" + table);
          } else {
            if (table === "bindings" && row.revoked === 0) {
              if (
                currentBindings.some(
                  (b) => b.revoked === 1 && overlapsBinding(row, b),
                )
              )
                throw Error("history-recovery-binding-revocation-conflict");
              if (
                rows(merged, "bindings").some(
                  (b) =>
                    b.revoked === 0 &&
                    b.account_id !== row.account_id &&
                    overlapsBinding(row, b),
                )
              )
                throw Error("history-recovery-binding-overlap-conflict");
            }
            if (table === "annotations") {
              const session = merged
                .prepare("SELECT notes,pinned FROM sessions WHERE id=?")
                .get(row.session_id) as Row | undefined;
              if (
                session &&
                (session.notes !== row.notes || session.pinned !== row.pinned)
              )
                throw Error("history-recovery-conflicting-annotations");
            }
            insertRaw(table, row);
            counts[counter]++;
          }
        }
      }
      // Preserve legacy local identity, config, audit and derived history as
      // evidence. They never replace the current installation's live settings.
      for (const table of [
        "settings",
        "cursors",
        "sessions",
        "audit",
        "notifications",
        "pending_projection",
        "usage_points",
      ]) {
        for (const row of legacy
          .prepare(`SELECT * FROM "${table}"`)
          .iterate() as Iterable<Row>)
          archive(table, row);
      }
      const metadataKeys = new Set<string>();
      for (const row of merged
        .prepare("SELECT * FROM events WHERE kind='session_meta'")
        .all() as Row[]) {
        const key = metadataKey(row);
        if (key) metadataKeys.add(key);
      }
      const getEvent = merged.prepare("SELECT * FROM events WHERE id=?");
      const addEvent = merged.prepare(
        "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const row of legacy
        .prepare("SELECT * FROM events ORDER BY occurred_at,id")
        .iterate() as Iterable<Row>) {
        if (tombstones.has(row.session_id)) {
          counts.eventsArchived += archive("events", row);
          continue;
        }
        const existing = getEvent.get(row.id) as Row | undefined;
        if (existing) {
          if (canonical(existing) !== canonical(row))
            counts.eventsArchived += archive("events", row);
          continue;
        }
        const key = metadataKey(row);
        if (key && metadataKeys.has(key)) {
          counts.metadataDuplicatesArchived += archive("events", row);
          continue;
        }
        addEvent.run(
          row.id,
          row.session_id,
          row.turn_id,
          row.kind,
          row.occurred_at,
          row.source_id,
          row.account_id,
          row.project_id,
          row.json,
        );
        counts.eventsAdded++;
        changedSessions.add(row.session_id);
        if (key) metadataKeys.add(key);
      }
      const getQuota = merged.prepare("SELECT * FROM quotas WHERE id=?");
      for (const row of legacy
        .prepare("SELECT * FROM quotas")
        .iterate() as Iterable<Row>) {
        const existing = getQuota.get(row.id) as Row | undefined;
        if (existing) {
          if (canonical(existing) !== canonical(row))
            counts.quotasArchived += archive("quotas", row);
        } else {
          insertRaw("quotas", row);
          counts.quotasAdded++;
        }
      }
      // Legacy session rows without events cannot be reconstructed; preserve
      // them verbatim (including notes/pins) instead of inventing event evidence.
      for (const row of rows(legacy, "sessions")) {
        if (tombstones.has(row.id)) continue;
        const existing = merged
          .prepare("SELECT notes,pinned FROM sessions WHERE id=?")
          .get(row.id) as Row | undefined;
        if (!existing) insertRaw("sessions", row);
        else if (
          (row.notes || row.pinned) &&
          (existing.notes !== row.notes || existing.pinned !== row.pinned)
        )
          throw Error("history-recovery-conflicting-annotations");
      }
      merged
        .prepare(
          "INSERT OR IGNORE INTO history_recovery_inputs VALUES(?,?,?,?)",
        )
        .run(
          legacySha256,
          legacySchema,
          count(legacy, "events"),
          count(legacy, "sessions"),
        );
      merged.exec("COMMIT");
    } catch (e) {
      merged.exec("ROLLBACK");
      throw e;
    }
    if (currentSchema < 3)
      for (const row of merged
        .prepare("SELECT DISTINCT session_id FROM events")
        .all() as Row[])
        changedSessions.add(row.session_id);
    // projectDirty consumes its Set; keep the recovery population for reporting.
    projector.dirty = new Set(changedSessions);
    projector.projectDirty();
    if (currentSchema < 3) projector.setSetting("derivedProjectionVersion", 5);
    counts.sessionsRecovered = [...changedSessions].filter((id) => {
      const before = current!
        .prepare("SELECT uncertain FROM sessions WHERE id=?")
        .get(id) as Row | undefined;
      const after = merged!
        .prepare("SELECT uncertain FROM sessions WHERE id=?")
        .get(id) as Row | undefined;
      return (
        (!before || before.uncertain === 2) && after && after.uncertain !== 2
      );
    }).length;
    const sameSettings = assertSameRows(
      current,
      merged,
      "settings",
      ["key"],
      (r) => currentSchema < 3 && r.key === "derivedProjectionVersion",
    );
    const sameEvents = assertSameRows(current, merged, "events", ["id"], (r) =>
      tombstones.has(r.session_id),
    );
    const sameCursors = assertSameRows(current, merged, "cursors", ["path"]);
    const syncTables = (
      current
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Row[]
    )
      .map((r) => r.name as string)
      .filter(
        (n) =>
          /^(sync_|event_grants$)/.test(n) || ["grants", "outbox"].includes(n),
      );
    const sameSync = syncTables.every(
      (t) => canonical(rows(current!, t)) === canonical(rows(merged!, t)),
    );
    const sameAttribution = assertAccountAttribution(
      current,
      merged,
      tombstones,
    );
    if (!sameSettings || !sameEvents || !sameCursors || !sameSync)
      throw Error("history-recovery-preservation-check-failed");
    for (const row of rows(current, "sessions")) {
      if (tombstones.has(row.id)) continue;
      const after = merged
        .prepare("SELECT notes,pinned FROM sessions WHERE id=?")
        .get(row.id) as Row | undefined;
      if (!after || after.notes !== row.notes || after.pinned !== row.pinned)
        throw Error("history-recovery-preservation-check-failed");
    }
    if (
      inspect(merged) !== 3 ||
      merged.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("history-recovery-invalid-output");
    // Recheck the completed-snapshot condition as well as the main-file hash:
    // concurrent WAL writes may not change the main SQLite file at all.
    validateSnapshot(currentPath);
    validateSnapshot(legacyPath);
    const inputHashes =
      digest(currentPath) === currentSha256 &&
      digest(legacyPath) === legacySha256;
    if (!inputHashes) throw Error("history-recovery-input-changed");
    const summary: HistoryRecoverySummary = {
      version: 1,
      input: { currentSha256, legacySha256, currentSchema, legacySchema },
      counts,
      result: {
        sessions: count(merged, "sessions"),
        events: count(merged, "events"),
        usagePoints: count(merged, "usage_points"),
        integrity: "ok",
      },
      preserved: {
        currentEvents: sameEvents,
        currentSettings: sameSettings,
        currentCursors: sameCursors,
        currentSync: sameSync,
        ...sameAttribution,
        inputHashes,
      },
      idempotent:
        alreadyImported &&
        count(merged, "history_recovery_evidence") === beforeEvidence &&
        !counts.eventsAdded &&
        !counts.quotasAdded &&
        !counts.tombstonesAdded,
    };
    merged.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    merged.close();
    merged = undefined;
    if (outputDir)
      fs.writeFileSync(
        path.join(resultDir, "history-recovery-summary.json"),
        JSON.stringify(summary, null, 2),
        { flag: "wx" },
      );
    return { ...summary, ...(outputDir ? { file } : {}) };
  } finally {
    merged?.close();
    current?.close();
    legacy?.close();
    removeScratch(scratch, parent);
  }
}
export async function planHistoryRecovery(
  options: RecoveryOptions,
): Promise<HistoryRecoverySummary> {
  return run(options);
}
export async function recoverHistory(
  options: RecoveryOptions & { outputDir?: string; output?: string },
): Promise<HistoryRecoverySummary & { file: string }> {
  const outputDir = options.outputDir ?? options.output;
  if (!outputDir) throw Error("history-recovery-output-required");
  return (await run(options, outputDir)) as HistoryRecoverySummary & {
    file: string;
  };
}
