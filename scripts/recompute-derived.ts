import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "../core/store.js";
import { Collector } from "../collector/collector.js";
import { createHash } from "node:crypto";

const args = process.argv.slice(2),
  index = args.indexOf("--data-dir");
if (index < 0 || !args[index + 1])
  throw Error(
    "Usage: node dist/scripts/recompute-derived.js --data-dir <Monitor data directory> [--apply]",
  );
const dataDir = path.resolve(args[index + 1]),
  apply = args.includes("--apply");
const file = path.join(dataDir, "monitor.sqlite");
if (!fs.existsSync(file))
  throw Error(
    "Monitor database not found; no new source database will be created",
  );
const backupDir = path.join(dataDir, "backups", `reliability-${Date.now()}`);
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, "monitor.sqlite");
// Backup before Store opens/migrates: SQLite backup includes committed WAL pages.
const source = new DatabaseSync(file, { readOnly: true });
try {
  await backup(source, backupFile);
} finally {
  source.close();
}
for (const name of ["hook-install.json", "hook-enabled.json"])
  if (fs.existsSync(path.join(dataDir, name)))
    fs.copyFileSync(path.join(dataDir, name), path.join(backupDir, name));
const target = apply ? dataDir : path.join(backupDir, "validation-copy");
if (!apply) {
  fs.mkdirSync(target);
  fs.copyFileSync(backupFile, path.join(target, "monitor.sqlite"));
  // Same-computer isolated validation needs the existing encryption key. This
  // is never a device-transfer backup and is not included in release artifacts.
  for (const name of ["credential-key.local", "credential-key.dpapi"])
    if (fs.existsSync(path.join(dataDir, name)))
      fs.copyFileSync(path.join(dataDir, name), path.join(target, name));
}
const store = new Store(target);
try {
  const digest = (sql: string) =>
    createHash("sha256")
      .update(JSON.stringify(store.db.prepare(sql).all()))
      .digest("hex");
  const protectedTables = (
    store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter(
      (name) =>
        ![
          "sessions",
          "usage_points",
          "pending_projection",
          "settings",
          "audit",
          "events",
          "cursors",
        ].includes(name),
    );
  const protectedState = () =>
    Object.fromEntries([
      ...protectedTables.map((name) => [
        name,
        digest(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`),
      ]),
      [
        "privateSessionFields",
        digest("SELECT id,notes,pinned FROM sessions ORDER BY id"),
      ],
      [
        "settings",
        digest(
          "SELECT * FROM settings WHERE key NOT IN ('derivedProjectionVersion','derivedProjectionRepair','indexRebuilding') ORDER BY key",
        ),
      ],
    ]);
  const frozen = protectedState();
  const originalEvents = store.db
    .prepare("SELECT id,json FROM events ORDER BY id")
    .all() as { id: string; json: string }[];
  const originalIds = new Set(originalEvents.map((e) => e.id));
  const before = store.overview().usage;
  const baselineRepair = await new Collector(store).repairForkBaselines({
    backupAlreadyTaken: true,
  });
  const result = await store.recomputeDerived({ backup: false, force: true });
  const first = store.overview().usage;
  const firstProjection = [
    digest("SELECT * FROM sessions ORDER BY id"),
    digest("SELECT * FROM usage_points ORDER BY id"),
  ];
  await store.recomputeDerived({ backup: false, force: true });
  const second = store.overview().usage;
  const repeatedBaselineRepair = await new Collector(store).repairForkBaselines(
    { backupAlreadyTaken: true },
  );
  const afterEvents = store.db
    .prepare("SELECT id,json FROM events ORDER BY id")
    .all() as { id: string; json: string }[];
  const afterById = new Map(afterEvents.map((e) => [e.id, e.json]));
  const integrity = store.db.prepare("PRAGMA integrity_check").get();
  const report = {
    mode: apply ? "applied" : "validation-copy",
    backupDirectory: backupDir,
    result,
    baselineRepair,
    repeatedBaselineRepair,
    originalEventsPreserved: originalEvents.every(
      (e) => afterById.get(e.id) === e.json,
    ),
    addedEvents: afterEvents.filter((e) => !originalIds.has(e.id)).length,
    before,
    after: first,
    repeatEqual:
      JSON.stringify(firstProjection) ===
        JSON.stringify([
          digest("SELECT * FROM sessions ORDER BY id"),
          digest("SELECT * FROM usage_points ORDER BY id"),
        ]) && JSON.stringify(first) === JSON.stringify(second),
    protectedStateUnchanged:
      JSON.stringify(frozen) === JSON.stringify(protectedState()),
    protectedDigests: protectedState(),
    integrity,
  };
  fs.writeFileSync(
    path.join(backupDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
