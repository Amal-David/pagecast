import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("browser and extension mutations obtain and send the admin CSRF token", async () => {
  const [apiSource, csrfSource, backgroundSource, popupSource] = await Promise.all([
    source("web/src/lib/api.ts"),
    source("web/src/lib/csrf-recovery.js"),
    source("extension/background.js"),
    source("extension/popup.js")
  ]);

  for (const [name, contents] of [
    ["browser API", `${apiSource}\n${csrfSource}`],
    ["extension background", backgroundSource],
    ["extension popup", popupSource]
  ]) {
    assert.match(contents, /\/api\/session/, `${name} must obtain an admin session`);
    assert.match(
      contents,
      /X-Pagecast-CSRF/,
      `${name} must attach the session CSRF token to mutations`
    );
    if (name.startsWith("extension")) {
      assert.match(
        contents,
        /X-Pagecast-Extension/,
        `${name} must identify the constrained extension adapter`
      );
    }
  }

  assert.match(
    csrfSource,
    /(?:GET|HEAD|OPTIONS)/,
    "the browser API must distinguish reads from mutations centrally"
  );
});

test("preview frames are sandboxed on the dedicated public origin", async () => {
  const [appSource, dialogSource, viteSource] = await Promise.all([
    source("web/src/App.tsx"),
    source("web/src/components/preview-dialog.tsx"),
    source("web/vite.config.ts")
  ]);

  const frames = `${appSource}\n${dialogSource}`.match(/<iframe[\s\S]*?\/>/g) ?? [];
  assert.equal(frames.length, 2, "all preview iframe sites should be covered by this test");

  for (const frame of frames) {
    assert.match(frame, /sandbox=/, "preview iframe must be sandboxed");
    assert.match(frame, /allow-scripts/, "interactive report scripts must continue to work");
    assert.match(frame, /allow-same-origin/, "module and relative asset access must continue to work");
    assert.doesNotMatch(
      frame,
      /allow-top-navigation/,
      "preview content must not navigate the admin window"
    );
  }

  assert.doesNotMatch(
    viteSource,
    /["']\/(?:preview|p)["']\s*:/,
    "Vite must not re-expose public report content on the admin UI origin"
  );
});

test("the browser FeedbackConfig type exposes display metadata only", async () => {
  const typesSource = await source("web/src/lib/types.ts");
  const feedbackConfig = /export interface FeedbackConfig\s*\{([\s\S]*?)\}/.exec(
    typesSource
  );

  assert.ok(feedbackConfig, "FeedbackConfig should remain an explicit public DTO");
  assert.match(feedbackConfig[1], /url:\s*string/);
  assert.match(feedbackConfig[1], /workerName:\s*string/);
  assert.doesNotMatch(feedbackConfig[1], /statsToken|kvId/);
});

test("the browser exposes explicit existing-project adoption instead of disabling the current target", async () => {
  const [connectSource, appSource, hookSource, typesSource] = await Promise.all([
    source("web/src/components/cloudflare-connect.tsx"),
    source("web/src/App.tsx"),
    source("web/src/hooks/use-cloudflare.ts"),
    source("web/src/lib/types.ts")
  ]);

  assert.match(typesSource, /managed:\s*boolean/);
  assert.match(typesSource, /requiresAdoption:\s*boolean/);
  assert.match(hookSource, /adoptExisting:\s*true/);
  assert.match(connectSource, /requiresAdoption/);
  assert.match(connectSource, /"Adopt"/);
  assert.match(appSource, /const canAdopt = isCurrent && requiresAdoption/);
  assert.doesNotMatch(
    `${connectSource}\n${appSource}`,
    /disabled=\{isCurrent\s*\|\|/,
    "the selected project must stay actionable when explicit adoption is required"
  );
});
