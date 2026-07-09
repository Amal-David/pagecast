import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PINNED_WRANGLER_VERSION } from "../src/platform.js";

function read(file) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

function json(file) {
  return JSON.parse(read(file));
}

function skillVersion(file) {
  return read(file).match(/^version:\s*(\S+)$/m)?.[1] || "";
}

test("package-facing component versions stay aligned", () => {
  const packageManifest = json("package.json");
  const expected = packageManifest.version;
  assert.equal(json("extension/manifest.json").version, expected);
  assert.equal(json("plugin/.claude-plugin/plugin.json").version, expected);
  assert.equal(skillVersion(".codex/skills/publish-report/SKILL.md"), expected);
  assert.equal(skillVersion("plugin/skills/publish-report/SKILL.md"), expected);
  assert.match(read("README.md"), /pagecast-extension-v<version>\.zip/);
  assert.match(read("README.md"), /github\.com\/Amal-David\/pagecast\/releases/);
  for (const document of [
    "ARCHITECTURE.md",
    "CHANGELOG.md",
    "PASSWORD-PROTECTION.md",
    "PRIVACY.md",
    "SECURITY.md"
  ]) {
    assert.ok(packageManifest.files.includes(document), `${document} must ship in npm`);
  }
});

test("CI covers the supported OS and Node matrix plus artifact proofs", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /os:\s*\[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /node:\s*\["20\.19\.0", 22\]/);
  assert.match(workflow, /pnpm -C web run build/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /pnpm -C web exec tsc --noEmit/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /createWranglerInvocation\(\['--version'\]/);
  assert.match(workflow, /git diff --exit-code -- public/);
  assert.match(workflow, /npm pack --ignore-scripts --json/);
  assert.match(workflow, /npm install --prefix "\$smoke_dir" --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /node_modules\/\.bin\/pagecast" --help/);
  assert.match(workflow, /docker build --check \. && docker build -t pagecast:ci \./);
  assert.match(
    workflow,
    /docker run --rm --network none --entrypoint node pagecast:ci/
  );
  assert.match(workflow, /invocation\.command !== "wrangler"/);
});

test("Node, native Wrangler, and the offline container runtime stay aligned", () => {
  assert.equal(PINNED_WRANGLER_VERSION, "4.86.0");
  assert.equal(json("package.json").engines.node, ">=20.19.0");
  assert.match(read("README.md"), /Requires Node\.js 20\.19\+/);
  assert.match(read("plugin/README.md"), /Node\.js >= 20\.19\.0/);
  assert.match(read("Dockerfile"), /PAGECAST_USE_GLOBAL_WRANGLER=1/);
});

test("security and extension privacy docs describe reusable process-scoped tokens accurately", () => {
  const security = read("SECURITY.md");
  const extensionPrivacy = read("extension/store/PRIVACY.md");
  assert.match(security, /reusable opaque, shell-safe\s+transport tokens/);
  assert.match(security, /not secrets or access-control tokens/);
  assert.doesNotMatch(security, /opaque one-time tokens/);
  assert.match(extensionPrivacy, /per-process Pagecast admin-session\s+token/);
  assert.match(extensionPrivacy, /rotates when the Pagecast process restarts/);
  assert.doesNotMatch(extensionPrivacy, /short-lived Pagecast admin-session/);
});

test("release publishing is verification-gated and labels extension assets from the manifest", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+version:/);
  assert.match(workflow, /EXPECTED_VERSION:/);
  assert.match(workflow, /require\("\.\/package\.json"\)\.version/);
  assert.doesNotMatch(workflow, /require\(\\"\.\/package\.json\\"\)/);
  assert.equal((workflow.match(/needs: verify/g) || []).length, 3);
  assert.match(workflow, /npm pack --ignore-scripts --json/);
  assert.match(workflow, /npm install --prefix "\$smoke_dir" --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /docker build -t pagecast:release-verify/);
  assert.match(workflow, /docker run --rm --network none/);
  assert.match(workflow, /require\("\.\/extension\/manifest\.json"\)\.version/);
  assert.match(workflow, /pagecast-extension-v\$\{version\}\.zip/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
});

test("the web toolchain pins patched Vite and esbuild versions", () => {
  const web = json("web/package.json");
  assert.equal(web.devDependencies.vite, "7.3.5");
  assert.equal(web.devDependencies.esbuild, "0.28.1");
  assert.equal(web.pnpm?.overrides?.esbuild, "0.28.1");
});
