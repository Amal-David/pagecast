import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Worker runtime declares fetch, queue, scheduled, and a Durable Object", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

  assert.match(source, /async fetch\(/);
  assert.match(source, /async queue\(/);
  assert.match(source, /async scheduled\(/);
  assert.match(source, /export class PublicationOwner/);
  for (const kind of ["accessibility_check", "expire", "index", "link_check", "notify", "render_preview", "webhook"]) {
    assert.match(types, new RegExp(`\\\"${kind}\\\"`));
  }
});
