import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(process.argv[2]);
const { removeStagingEntry } = await import(pathToFileURL(path.join(packageRoot, "src/staging-remove.js")));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-packaged-cleanup-"));
try {
  const relative = path.join("target", "deploy-smoke");
  await fs.mkdir(path.join(root, relative), { recursive: true });
  await fs.writeFile(path.join(root, relative, "payload"), "temporary staging");
  await removeStagingEntry(root, relative, await fs.lstat(root, { bigint: true }));
  assert.deepEqual(await fs.readdir(path.join(root, "target")), []);
  console.log("Packaged staging cleanup helper passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
