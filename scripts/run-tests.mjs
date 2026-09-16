import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../test/", import.meta.url))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => `test/${name}`);
if (!files.length) throw new Error("No root test files found.");
// Node 20 on Windows does not expand shell globs. Keep Worker tests separate.
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
