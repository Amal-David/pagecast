import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeStagingEntry } from "../src/staging-remove.js";

test("handle-bound removal rejects a replaced ancestor and preserves deployed content", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-native-remove-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "staging");
  const group = path.join(root, "target");
  const outside = path.join(temp, "last-deployed");
  await fs.mkdir(path.join(group, "deploy-abandoned"), { recursive: true });
  await fs.mkdir(path.join(outside, "deploy-abandoned"), { recursive: true });
  const saved = path.join(outside, "deploy-abandoned", "index.html");
  await fs.writeFile(saved, "preserved deployment");
  const identity = await fs.lstat(root, { bigint: true });
  await fs.rename(group, path.join(temp, "original-target"));
  await fs.symlink(outside, group, "junction");
  await assert.rejects(removeStagingEntry(root, path.join("target", "deploy-abandoned"), identity), /outside|escape|root|path|link/i);
  assert.equal(await fs.readFile(saved, "utf8"), "preserved deployment");
  await fs.rm(group);
  await fs.rename(path.join(temp, "original-target"), group);
  await removeStagingEntry(root, path.join("target", "deploy-abandoned"), identity);
  assert.deepEqual(await fs.readdir(group), []);
});

test("handle-bound removal refuses a replaced root and paths outside staging", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-native-root-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "staging");
  const outside = path.join(temp, "saved-publications");
  await fs.mkdir(root);
  await fs.mkdir(path.join(outside, "target", "deploy-abandoned"), { recursive: true });
  const saved = path.join(outside, "target", "deploy-abandoned", "index.html");
  await fs.writeFile(saved, "preserved publication");
  const identity = await fs.lstat(root, { bigint: true });
  await assert.rejects(removeStagingEntry(root, "../saved-publications", identity), /relative|local/i);
  await fs.rename(root, path.join(temp, "original-staging"));
  await fs.symlink(outside, root, "junction");
  await assert.rejects(removeStagingEntry(root, path.join("target", "deploy-abandoned"), identity), /root changed/i);
  assert.equal(await fs.readFile(saved, "utf8"), "preserved publication");
});
