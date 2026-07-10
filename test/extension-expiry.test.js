import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("the extension formats effective expiries consistently", async () => {
  const expirySource = await source("extension/expiry.js");
  const context = {};
  vm.runInNewContext(expirySource, context, { filename: "extension/expiry.js" });

  assert.equal(context.PagecastExpiry.format(null), "Expires: never.");
  assert.equal(context.PagecastExpiry.format(0), "Expires: never.");
  assert.equal(
    context.PagecastExpiry.format(Date.UTC(2030, 0, 1)),
    "Expires: 2030-01-01T00:00:00.000Z."
  );
});

test("popup, background notification, and goal CLI all expose effective expiry", async () => {
  const [popupHtml, popup, background, cli] = await Promise.all([
    source("extension/popup.html"),
    source("extension/popup.js"),
    source("extension/background.js"),
    source("src/cli.js")
  ]);

  assert.match(
    popupHtml,
    /<script src="expiry\.js"><\/script>[\s\S]*<script src="popup\.js"><\/script>/,
    "the popup must load the shared expiry formatter before its controller"
  );
  assert.match(popup, /PagecastExpiry\.format\(data\.publication\?\.expiresAt\)/);
  assert.match(background, /importScripts\([^)]*"expiry\.js"[^)]*\)/);
  assert.match(background, /PagecastExpiry\.format\(data\.publication\?\.expiresAt\)/);

  const goalCommand = /async function goal\(args\) \{([\s\S]*?)\n\}/.exec(cli)?.[1] || "";
  assert.match(goalCommand, /result\.expiresAt/);
  assert.match(goalCommand, /Expires:/);
});
