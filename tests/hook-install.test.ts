import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  configureHooks,
  installationStatus,
} from "../collector/hook-install.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-toggle-"));
  const data = path.join(root, "data"),
    home = path.join(root, "codex");
  fs.mkdirSync(data);
  fs.mkdirSync(home);
  return {
    root,
    data,
    home,
    file: path.join(home, "hooks.json"),
    clean: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
test("one switch merges idempotently, preserves unrelated handlers, backs up exact input and removes only owned entries", () => {
  const f = fixture();
  try {
    const other = { type: "command", command: "echo other" };
    const original = {
      description: "user config",
      hooks: { Stop: [{ matcher: "*", hooks: [other] }] },
    };
    const bytes = JSON.stringify(original, null, 4);
    fs.writeFileSync(f.file, bytes);
    assert.equal(installationStatus(f.data, false).status, "off");
    configureHooks(f.data, true, f.home);
    const first = fs.readFileSync(f.file, "utf8");
    configureHooks(f.data, true, f.home);
    assert.equal(fs.readFileSync(f.file, "utf8"), first);
    assert.equal(installationStatus(f.data, true).status, "awaiting_event");
    assert.equal(
      installationStatus(
        f.data,
        true,
        new Date(Date.now() + 1000).toISOString(),
      ).status,
      "observed",
    );
    const backup = fs.readdirSync(path.join(f.data, "hook-backups"))[0];
    assert.equal(
      fs.readFileSync(path.join(f.data, "hook-backups", backup), "utf8"),
      bytes,
    );
    // A different program can add a handler to our group without losing its work on disable.
    const mixed = JSON.parse(first);
    mixed.hooks.Stop[1].hooks.push(other);
    fs.writeFileSync(f.file, JSON.stringify(mixed));
    configureHooks(f.data, false, f.home);
    const after = JSON.parse(fs.readFileSync(f.file, "utf8"));
    assert.equal(after.description, original.description);
    assert.deepEqual(
      after.hooks.Stop.map((g: any) => g.hooks),
      [[other], [other]],
    );
    assert.deepEqual(Object.keys(after.hooks), ["Stop"]);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(f.data, "hook-enabled.json"), "utf8"),
      ).enabled,
      false,
    );
  } finally {
    f.clean();
  }
});
test("malformed or concurrently locked config is not overwritten or falsely enabled", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, "{broken");
    assert.throws(() => configureHooks(f.data, true, f.home));
    assert.equal(fs.readFileSync(f.file, "utf8"), "{broken");
    assert.equal(installationStatus(f.data, true).status, "needs_setup");
    fs.writeFileSync(f.file, "{}");
    fs.writeFileSync(f.file + ".aiwm.lock", "owned by another writer");
    assert.throws(() => configureHooks(f.data, true, f.home));
    assert.equal(fs.readFileSync(f.file, "utf8"), "{}");
    assert.equal(
      fs.readFileSync(f.file + ".aiwm.lock", "utf8"),
      "owned by another writer",
    );
  } finally {
    f.clean();
  }
});
test("modified owned handler is preserved on disable; a cached callback becomes inert", () => {
  const f = fixture();
  try {
    configureHooks(f.data, true, f.home);
    const doc = JSON.parse(fs.readFileSync(f.file, "utf8"));
    doc.hooks.Stop[0].hooks[0].timeout = 3;
    fs.writeFileSync(f.file, JSON.stringify(doc));
    const result = configureHooks(f.data, false, f.home);
    assert.ok(result.cleanupError);
    assert.equal(
      JSON.parse(fs.readFileSync(f.file, "utf8")).hooks.Stop[0].hooks[0]
        .timeout,
      3,
    );
    const callback = spawnSync(
      process.execPath,
      ["scripts/hook-receiver.mjs", f.data],
      {
        input: JSON.stringify({ session_id: "x", hook_event_name: "Stop" }),
        encoding: "utf8",
        timeout: 2500,
        windowsHide: true,
      },
    );
    assert.equal(callback.status, 0);
    assert.equal(callback.stdout, "");
    assert.equal(fs.existsSync(path.join(f.data, "hook-queue.jsonl")), false);
  } finally {
    f.clean();
  }
});
