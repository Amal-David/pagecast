import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

test("page and Home Activity surfaces expose the privacy-safe access contract", () => {
  const app = source("web/src/App.tsx");
  const row = source("web/src/components/publication-row.tsx");
  const activity = source("web/src/components/activity-panel.tsx");

  assert.match(app, /GlobalActivity/);
  assert.match(app, /activeView === "activity"/);
  assert.match(row, /PublicationActivitySummary/);
  assert.match(activity, /anonymous unique/);
  assert.match(activity, /Country/);
  assert.match(activity, /Region \/ city/);
  assert.match(activity, /ASN \/ organization/);
  assert.match(activity, /Referrer/);
  assert.match(activity, /Unlisted link/);
  assert.match(activity, /Password protected/);
  assert.match(activity, /audit visibility, not visitor identity or prevention/);
});
