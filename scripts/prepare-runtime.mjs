import fs from "node:fs";
import path from "node:path";
if (
  process.platform !== "win32" ||
  Number(process.versions.node.split(".")[0]) < 24
)
  throw Error("请在 Windows x64 Node 24+ 环境打包");
const out = path.resolve("work/runtime");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(process.execPath, path.join(out, "node.exe"));
const license =
  process.env.AIWM_NODE_LICENSE ||
  path.join(path.dirname(process.execPath), "LICENSE");
if (fs.existsSync(license))
  fs.copyFileSync(license, path.join(out, "NODE_LICENSE"));
else throw Error("Node运行时LICENSE未找到，禁止遗漏许可证打包");
console.log("Prepared bundled Node runtime " + process.version);
