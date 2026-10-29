import path from "node:path";
import {
  planHistoryRecovery,
  recoverHistory,
} from "../core/history-recovery.js";

// Offline only: inputs must be completed SQLite snapshots, not live databases.
// The command never replaces either input and never starts collection/sync.
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (
    ![
      "--current",
      "--legacy",
      "--output",
      "--work-dir",
      "--expected-current-sha256",
      "--expected-legacy-sha256",
    ].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--") ||
    options.has(args[i])
  ) {
    console.error(
      "Usage: history-recovery --current <completed.sqlite> --legacy <completed.sqlite> [--output <new-directory>] [--work-dir <scratch-parent>]",
    );
    process.exit(2);
  }
  options.set(args[i], args[i + 1]);
}
if (!options.has("--current") || !options.has("--legacy")) {
  console.error(
    "history-recovery: --current and --legacy completed snapshots are required",
  );
  process.exit(2);
}
try {
  const input = {
    current: path.resolve(options.get("--current")!),
    legacy: path.resolve(options.get("--legacy")!),
    workDir: options.has("--work-dir")
      ? path.resolve(options.get("--work-dir")!)
      : undefined,
    expectedCurrentSha256: options.get("--expected-current-sha256"),
    expectedLegacySha256: options.get("--expected-legacy-sha256"),
  };
  const result = options.has("--output")
    ? await recoverHistory({
        ...input,
        outputDir: path.resolve(options.get("--output")!),
      })
    : await planHistoryRecovery(input);
  // Reports contain counts and hashes; no raw records, identities or settings.
  const { file: _file, ...summary } = result as typeof result & {
    file?: string;
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^history-recovery-[a-z-]+$/.test(message)
      ? message
      : "history-recovery-failed-see-local-inputs",
  );
  process.exitCode = 1;
}
