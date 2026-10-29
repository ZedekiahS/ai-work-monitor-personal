import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "../core/model.js";
import { readDatabaseHistory } from "../collector/database-history.js";

function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), "aiwm-history-"));
  const file = path.join(root, "thread_history_1.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,started_at INTEGER,status TEXT,PRIMARY KEY(thread_id,turn_id));
CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,item_type TEXT,item_json TEXT,PRIMARY KEY(thread_id,item_id));`);
  t.after(() => {
    try {
      db.close();
    } catch {}
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
      throw Error("unsafe test cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  const put = (
    id: string,
    ordinal: number,
    item: unknown,
    thread = "wanted",
    turn = "turn",
  ) =>
    db
      .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)")
      .run(
        thread,
        turn,
        id,
        ordinal,
        1700000000000,
        null,
        (item as any)?.type ?? "unknown",
        typeof item === "string" ? item : JSON.stringify(item),
      );
  return { root, file, db, put };
}
test("bounded ordinal+item pagination has no gaps for same timestamps and stable IDs across calls", (t) => {
  const { root, put } = fixture(t);
  for (let n = 0; n < 210; n++)
    put("item-" + String(n).padStart(3, "0"), Math.floor(n / 2), {
      type: "agentMessage",
      text: "text " + n,
    });
  const first = readDatabaseHistory(root, "wanted");
  assert.equal(first.available, true);
  assert.equal(first.events.length, 200);
  const again = readDatabaseHistory(root, "wanted");
  assert.deepEqual(
    first.events.map((e) => e.id),
    again.events.map((e) => e.id),
  );
  const second = readDatabaseHistory(
    root,
    "wanted",
    String(first.events[0]!.data.historyCursor),
  );
  assert.equal(second.events.length, 10);
  const all = [...second.events, ...first.events];
  assert.equal(new Set(all.map((e) => e.id)).size, 210);
  assert.equal(all[0]!.data.text, "text 0");
  assert.equal(all.at(-1)!.data.text, "text 209");
  assert.equal(
    readDatabaseHistory(
      root,
      "wanted",
      String(second.events[0]!.data.historyCursor),
    ).events.length,
    0,
  );
});
test("message text is locally replayable with 50k cap but tool arguments/results/commands are excluded", (t) => {
  const { root, put } = fixture(t);
  put("u", 1, {
    type: "userMessage",
    content: [
      { type: "text", text: "用户问题" },
      { type: "image", path: "PRIVATE PATH" },
    ],
  });
  put("a", 2, { type: "agentMessage", text: "中".repeat(50020) });
  put("tool", 3, {
    type: "mcpToolCall",
    tool: "read_file",
    status: "failed",
    arguments: { password: "SECRET" },
    result: { content: "SECRET" },
    error: "SECRET",
  });
  put("command", 4, {
    type: "commandExecution",
    command: "SECRET",
    aggregatedOutput: "SECRET",
    cwd: "PRIVATE PATH",
    status: "completed",
  });
  put("thought", 5, {
    type: "reasoning",
    content: ["SECRET"],
    summary: ["SECRET"],
  });
  const result = readDatabaseHistory(root, "wanted");
  assert.equal(result.available, true);
  assert.equal(result.events[0]!.data.text, "用户问题");
  assert.equal(result.events[1]!.data.text.length, 50000);
  assert.equal(result.events[1]!.data.truncated, true);
  assert.equal(result.events[2]!.data.name, "read_file");
  assert.equal(result.events[2]!.data.status, "failed");
  assert.ok(
    result.events.every(
      (e) =>
        ![
          "turn_failed",
          "turn_completed",
          "usage_snapshot",
          "usage_response",
        ].includes(e.kind),
    ),
  );
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE PATH"));
  assert.ok(result.events.every((e) => e.data.localOnly));
});
test("turn join is scoped to both thread and turn; no other thread text or runtime status leaks", (t) => {
  const { root, db, put } = fixture(t);
  db.prepare("INSERT INTO thread_turns VALUES(?,?,?,?)").run(
    "wanted",
    "turn",
    1700000000,
    "inProgress",
  );
  db.prepare("INSERT INTO thread_turns VALUES(?,?,?,?)").run(
    "other",
    "turn",
    1800000000,
    "failed",
  );
  put("wanted-item", 1, { type: "agentMessage", text: "wanted" });
  put(
    "other-item",
    2,
    { type: "agentMessage", text: "PRIVATE OTHER THREAD" },
    "other",
  );
  const result = readDatabaseHistory(root, "wanted");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.sessionId, "wanted");
  assert.equal(result.events[0]!.turnId, "turn");
  assert.ok(!JSON.stringify(result).includes("PRIVATE OTHER THREAD"));
  assert.ok(!JSON.stringify(result).includes("inProgress"));
});
test("encrypted or malformed rows are not decoded and make content unavailable when no readable items exist", (t) => {
  const { root, put } = fixture(t);
  put("encrypted", 1, {
    type: "agentMessage",
    text: "SHOULD NOT SHOW",
    encrypted_content: "ciphertext",
  });
  put("bad", 2, "not-json SECRET");
  const result = readDatabaseHistory(root, "wanted");
  assert.equal(result.available, false);
  assert.equal(result.events.length, 2);
  assert.ok(!JSON.stringify(result).includes("SHOULD NOT SHOW"));
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("ciphertext"));
  assert.ok(result.events.every((e) => e.kind === "diagnostic"));
});
test("WAL reads are consistent and leave main database/WAL bytes unchanged", (t) => {
  const { root, file, db, put } = fixture(t);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  put("committed", 1, { type: "agentMessage", text: "committed" });
  const main = hash(readFileSync(file).toString("base64")),
    wal = hash(readFileSync(file + "-wal").toString("base64"));
  const result = readDatabaseHistory(root, "wanted");
  assert.equal(result.events.length, 1);
  assert.equal(hash(readFileSync(file).toString("base64")), main);
  assert.equal(hash(readFileSync(file + "-wal").toString("base64")), wal);
});
test("missing source, invalid cursor, missing thread and corrupt database fail safely without source repair", (t) => {
  const { root, file, db } = fixture(t);
  assert.equal(
    readDatabaseHistory(path.join(root, "absent"), "wanted").available,
    false,
  );
  assert.equal(readDatabaseHistory(root, "wanted").available, false);
  assert.equal(
    readDatabaseHistory(root, "wanted", "2026-10-26T00:00:00Z").available,
    false,
  );
  assert.equal(readDatabaseHistory(root, "' OR 1=1 --").available, false);
  db.close();
  writeFileSync(file, "not a database SECRET");
  const before = readFileSync(file);
  const result = readDatabaseHistory(root, "wanted");
  assert.equal(result.available, false);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.deepEqual(readFileSync(file), before);
});
