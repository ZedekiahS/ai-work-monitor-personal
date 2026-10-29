import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const dir = path.resolve("work", "demo");
const source = path.join(dir, "source");
fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
for (const [id, parent] of [
  ["demo-root", null],
  ["demo-child-a", "demo-root"],
  ["demo-child-b", "demo-root"],
  ["demo-grandchild", "demo-child-a"],
] as const) {
  const stamp = new Date().toISOString();
  const rows = [
    {
      ordinal: 0,
      timestamp: stamp,
      type: "session_meta",
      payload: {
        id,
        creator_account_id: "demo-account-only",
        cwd: "C:\\Projects\\research",
        parent_thread_id: parent,
        agent_path: parent ? "资料核对" : "整理研究资料",
        originator: "cli",
        cli_version: "fixture",
        source: parent
          ? { subagent: { thread_spawn: { parent_thread_id: parent } } }
          : "cli",
      },
    },
    {
      ordinal: 1,
      timestamp: stamp,
      type: "turn_context",
      payload: { turn_id: "demo-turn-" + id, model: "gpt-5" },
    },
    {
      ordinal: 2,
      timestamp: stamp,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "demo-turn-" + id },
    },
    {
      ordinal: 3,
      timestamp: stamp,
      type: "token_usage_record",
      payload: {
        turn_id: "demo-turn-" + id,
        response_id: "demo-response-" + id,
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 700,
          output_tokens: 200,
          reasoning_output_tokens: 50,
        },
      },
    },
  ];
  fs.writeFileSync(
    path.join(source, "sessions", id + ".jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}
console.log(
  "DEMO 合成数据，独立目录，不读取真实Codex历史。状态静默后按规则变为未知。",
);
const child = spawn(process.execPath, [path.resolve("dist/server/index.js")], {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    CODEX_HOME: source,
    AIWM_DATA_DIR: path.join(dir, "monitor"),
    AIWM_PORT: "4319",
    AIWM_DEMO: "1",
  },
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
child.on("exit", (code) => process.exit(code ?? 0));
