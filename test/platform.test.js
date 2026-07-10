import assert from "node:assert/strict";
import test from "node:test";

import {
  PINNED_WRANGLER_VERSION,
  WRANGLER_GLOBAL_ENV,
  WRANGLER_VERSION_OVERRIDE_ENV,
  createWranglerInvocation,
  createWranglerNpxArgs,
  resolveWranglerVersion,
  selectBuildShell,
  wranglerPackageSpecifier
} from "../src/platform.js";

test("POSIX build commands run through sh -lc as one command argument", () => {
  const buildCommand = 'npm run build && echo "$HOME"';
  assert.deepEqual(selectBuildShell(buildCommand, { platform: "linux", env: {} }), {
    command: "sh",
    args: ["-lc", buildCommand]
  });
});

test("Windows build commands use ComSpec with cmd hardening flags", () => {
  const buildCommand = "npm run build && echo %TEMP%";
  assert.deepEqual(
    selectBuildShell(buildCommand, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", buildCommand]
    }
  );
  assert.equal(
    selectBuildShell(buildCommand, { platform: "win32", env: {} }).command,
    "cmd.exe"
  );
});

test("Wrangler npx arguments always carry the source-controlled exact pin", () => {
  assert.equal(resolveWranglerVersion({ env: {} }), PINNED_WRANGLER_VERSION);
  assert.equal(
    wranglerPackageSpecifier({ env: {} }),
    `wrangler@${PINNED_WRANGLER_VERSION}`
  );
  assert.deepEqual(
    createWranglerNpxArgs(["pages", "project", "list", "--json"], { env: {} }),
    [
      "--yes",
      `wrangler@${PINNED_WRANGLER_VERSION}`,
      "pages",
      "project",
      "list",
      "--json"
    ]
  );
});

test("Wrangler invocation uses the pinned npx package natively and the baked global binary in Docker", () => {
  const wranglerArgs = ["pages", "project", "list", "--json"];
  assert.deepEqual(createWranglerInvocation(wranglerArgs, { env: {} }), {
    command: "npx",
    args: ["--yes", `wrangler@${PINNED_WRANGLER_VERSION}`, ...wranglerArgs]
  });
  assert.deepEqual(
    createWranglerInvocation(wranglerArgs, {
      env: { [WRANGLER_GLOBAL_ENV]: "1" }
    }),
    {
      command: "wrangler",
      args: wranglerArgs
    }
  );
});

test("Wrangler compatibility tests can override only with another exact version", () => {
  const env = { [WRANGLER_VERSION_OVERRIDE_ENV]: "4.102.0-beta.1" };
  assert.equal(resolveWranglerVersion({ env }), "4.102.0-beta.1");
  assert.equal(
    createWranglerNpxArgs(["whoami"], { env })[1],
    "wrangler@4.102.0-beta.1"
  );

  assert.throws(
    () =>
      resolveWranglerVersion({
        env: { [WRANGLER_VERSION_OVERRIDE_ENV]: "latest" }
      }),
    /exact semantic version/i
  );
});
