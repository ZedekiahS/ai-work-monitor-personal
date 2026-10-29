// Optional user-reviewed hook. No stdout, no upstream network or context injection.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
let input = "";
const timer = setTimeout(() => process.exit(0), 1200);
process.stdin.on("data", (b) => {
  input += b;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(input);
    const text = (v) => (typeof v === "string" ? v.slice(0, 200) : null);
    const record = {
      schemaVersion: 2,
      kind: text(p.hook_event_name),
      sessionId: text(p.session_id),
      turnId: text(p.turn_id),
      agentId: text(p.agent_id),
      toolUseId:
        ["PreToolUse", "PostToolUse"].includes(p.hook_event_name) &&
        typeof p.tool_use_id === "string" &&
        p.tool_use_id.length > 0 &&
        p.tool_use_id.length <= 200
          ? p.tool_use_id
          : null,
      observedAt: new Date().toISOString(),
      waitsForUser: ["request_user_input", "request_user_input_async"].includes(
        String(p.tool_name ?? "")
          .split("__")
          .at(-1)
          .split(".")
          .at(-1),
      ),
    };
    const dir =
      process.argv[2] ??
      process.env.AIWM_DATA_DIR ??
      path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"),
        "AI Work Monitor",
      );
    const gate = JSON.parse(
      fs.readFileSync(path.join(dir, "hook-enabled.json"), "utf8"),
    );
    if (gate.enabled !== true) {
      clearTimeout(timer);
      process.exit(0);
    }
    fs.appendFileSync(
      path.join(dir, "hook-queue.jsonl"),
      JSON.stringify(record) + "\n",
    );
  } catch {}
  clearTimeout(timer);
  process.exit(0);
});
