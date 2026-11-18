import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cliPresence,
  inspectSourceDirectories,
  runCodexDoctor,
} from "../server/environment.js";

test("source checks distinguish absent, unreadable and empty session directories without returning content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiwm-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await inspectSourceDirectories(path.join(root, "missing")), {
    directory: "missing",
    sessions: null,
    archived: null,
  });
  await mkdir(path.join(root, "sessions", "2026", "11"), { recursive: true });
  assert.deepEqual(await inspectSourceDirectories(root), {
    directory: "readable",
    sessions: "empty",
    archived: "missing",
  });
  await writeFile(
    path.join(root, "sessions", "2026", "11", "private-session.jsonl"),
    "private message",
  );
  await writeFile(path.join(root, "archived_sessions"), "not a directory");
  assert.deepEqual(await inspectSourceDirectories(root), {
    directory: "readable",
    sessions: "found",
    archived: "unreadable",
  });
});

const help = {
  code: 0,
  stdout: "Usage: codex doctor [OPTIONS]\n  --json",
  stderr: "",
};
test("a doctor report with exit 1 retains real findings and drops identifying details", async () => {
  const calls: string[][] = [];
  const report = await runCodexDoctor(async (args) => {
    calls.push(args);
    if (args.includes("--help")) return help;
    return {
      code: 1,
      stderr: "local path",
      stdout: JSON.stringify({
        schemaVersion: 1,
        overallStatus: "fail",
        checks: {
          "network.http": {
            status: "fail",
            category: "network",
            summary: "private URL",
            details: { path: "private path" },
          },
          "auth.credentials": {
            status: "ok",
            category: "auth",
            details: { email: "private email" },
          },
        },
      }),
    };
  });
  assert.deepEqual(calls, [
    ["doctor", "--help"],
    ["doctor", "--json"],
  ]);
  assert.deepEqual(report, {
    state: "complete",
    overall: "fail",
    counts: { ok: 1, warning: 0, fail: 1 },
    attention: ["网络"],
  });
});

test("old Codex help, startup failure, timeouts and malformed reports never indicate a completed check", async () => {
  let calls = 0;
  assert.deepEqual(
    await runCodexDoctor(async () => {
      calls++;
      return { code: 0, stdout: "Usage: codex [OPTIONS] [PROMPT]", stderr: "" };
    }),
    { state: "unsupported" },
  );
  assert.equal(calls, 1);
  for (const [code, state] of [
    ["ENOENT", "missing"],
    ["timeout", "timeout"],
    [1, "failed"],
  ] as const) {
    assert.deepEqual(
      await runCodexDoctor(async () => ({ code, stdout: "", stderr: "" })),
      { state },
    );
  }
  assert.deepEqual(
    await runCodexDoctor(async (args) =>
      args.includes("--help")
        ? help
        : { code: 1, stdout: "garbled", stderr: "" },
    ),
    { state: "failed" },
  );
  assert.deepEqual(
    await cliPresence(async () => ({
      code: 0,
      stdout: "codex-cli 0.117.2\n",
      stderr: "",
    })),
    { status: "available", version: "0.117.2" },
  );
});
