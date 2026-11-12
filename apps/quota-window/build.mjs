import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = process.cwd(),
  out = path.join(root, "work/quota-only-app");
function run(exe, args) {
  const r = spawnSync(exe, args, { stdio: "inherit", shell: false });
  if (r.status !== 0) throw Error("Build failed");
}
run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "-p",
  "tsconfig.json",
]);
run(process.execPath, [
  "node_modules/vite/bin/vite.js",
  "build",
  "--config",
  "apps/quota-window/vite.config.ts",
]);
// This directory is generated staging only, never a user-data location.
if (fs.existsSync(out)) {
  if (fs.realpathSync(out) !== out || path.dirname(out) !== path.join(root,"work")) throw Error("Unexpected staging path");
  fs.rmSync(out,{recursive:true});
}
fs.mkdirSync(out, { recursive: true });
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(out, to));
};
for (const name of ["main.cjs", "preload.cjs"])
  copy("apps/quota-window/" + name, name);
copy("desktop/widget.cjs", "widget.cjs");
copy("desktop/assets/icon.png", "icon.png");
copy("desktop/assets/icon.ico", "icon.ico");
for (const name of ["quota-only.js", "quota-wire.js"])
  copy("dist/collector/" + name, "collector/" + name);
fs.cpSync("work/quota-only-ui", path.join(out, "ui"), { recursive: true });
for (const name of ["LICENSE", "third_party/codex-usage-desktop-LICENSE"])
  copy(name, name);
for (const name of ["react", "react-dom", "scheduler"])
  copy("node_modules/" + name + "/LICENSE", "licenses/" + name + "-LICENSE");
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "ai-quota-window",
      version: "0.1.0",
      type: "module",
      main: "main.cjs",
      description: "Standalone read-only Codex quota window",
      author: "ZedekiahS",
      license: "MIT",
    },
    null,
    2,
  ),
);
// Explicit allowlist: no Monitor server, Store, SQLite, task collector, sync or Node runtime.
if (process.argv.includes("--package"))
  run(process.execPath, [
    "node_modules/electron-builder/out/cli/cli.js",
    "--projectDir",
    out,
    "--config",
    path.join(root, "apps/quota-window/builder.cjs"),
    "--win",
    "nsis",
  ]);
