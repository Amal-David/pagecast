import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

test("first-run onboarding makes Cloudflare and the agent prompt primary", () => {
  const app = source("web/src/App.tsx");
  const onboarding = source("web/src/components/pagecast-home-onboarding.tsx");

  assert.match(app, /PagecastHomeOnboarding/);
  assert.match(app, /!connected\s*&&\s*reportItems\.length === 0/);
  assert.match(onboarding, /Connect Cloudflare/);
  assert.match(onboarding, /Publish this as a Pagecast/);
  assert.match(onboarding, /Wrangler/);
  assert.match(onboarding, /account:read/);
  assert.match(onboarding, /user:read/);
  assert.match(onboarding, /pages:write/);
  assert.match(onboarding, /\.pages\.dev/);
  assert.match(onboarding, /AddReport/);
});
