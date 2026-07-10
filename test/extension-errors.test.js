import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

async function loadErrors() {
  const context = {};
  vm.runInNewContext(await source("extension/errors.js"), context, {
    filename: "extension/errors.js"
  });
  return context.PagecastExtensionErrors;
}

test("extension publish failures distinguish timeouts, sessions, and dropped connections", async () => {
  const errors = await loadErrors();
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.match(errors.publishFailureMessage(abort), /timed out/i);

  const unauthorized = errors.adminSessionError(401);
  assert.match(errors.publishFailureMessage(unauthorized), /admin session \(401\)/i);

  const missingToken = errors.adminSessionError();
  assert.match(errors.publishFailureMessage(missingToken), /admin session/i);
  assert.doesNotMatch(errors.publishFailureMessage(missingToken), /\(null\)/);

  const untrusted = new Error('<img src=x onerror="alert(1)">');
  const networkMessage = errors.publishFailureMessage(untrusted);
  assert.match(networkMessage, /connection dropped/i);
  assert.doesNotMatch(networkMessage, /img|onerror|alert/);
});

test("popup and background load the shared error policy before publishing", async () => {
  const [popupHtml, popup, background] = await Promise.all([
    source("extension/popup.html"),
    source("extension/popup.js"),
    source("extension/background.js")
  ]);

  assert.match(popupHtml, /errors\.js[\s\S]*popup\.js/);
  assert.match(background, /importScripts\([^)]*"errors\.js"[^)]*\)/);
  for (const adapter of [popup, background]) {
    assert.match(adapter, /!data\?\.url/);
    assert.match(adapter, /PagecastExtensionErrors\.adminSessionError/);
    assert.match(adapter, /PagecastExtensionErrors\.publishFailureMessage/);
  }
  assert.match(popup, /showTextHint\(PagecastExtensionErrors\.publishFailureMessage/);
  assert.doesNotMatch(popup, /showHint\(msg/);
});
