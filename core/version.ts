import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes("/dist/") ? "../.." : "..",
);
export const appVersion: string = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;
