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

test("Settings navigation opens real sections and makes analytics discoverable", () => {
  const app = source("web/src/App.tsx");
  const navigation = /const settingsSections[\s\S]*?function settingsSectionId/.exec(app)?.[0] || "";
  const sidebar = /function SettingsSidebar[\s\S]*?function PageSidebar/.exec(app)?.[0] || "";
  const settings = /function SettingsView[\s\S]*$/.exec(app)?.[0] || "";

  for (const label of ["Publishing", "Deploy history", "Link defaults", "Analytics"]) {
    assert.match(navigation, new RegExp(`label: "${label}"`));
  }
  assert.match(sidebar, /type="button"/);
  assert.match(sidebar, /onClick=\{\(\) => onSelect\(id\)\}/);
  assert.match(sidebar, /aria-current=/);

  for (const section of ["publishing", "deploy-history", "link-defaults", "analytics"]) {
    assert.match(
      settings,
      new RegExp(`id=\\{settingsSectionId\\("${section}"\\)\\}`)
    );
  }
  assert.match(settings, /<ActivityPanel[\s\S]*global/);
});

test("page header actions keep the three-dot menu on the same row", () => {
  const app = source("web/src/App.tsx");
  const preview = /function PreviewPane[\s\S]*?function PublishProgress/.exec(app)?.[0] || "";
  const actions = /<div className="flex max-w-full[\s\S]*?<DropdownMenuContent align="end">/.exec(preview)?.[0] || "";

  assert.match(preview, /2xl:flex-row 2xl:items-center 2xl:justify-between/);
  assert.match(actions, /flex-nowrap/);
  assert.doesNotMatch(actions, /\bflex-wrap\b/);
});

test("settings entry points reset consistently and analytics enablement has one rule", () => {
  const app = source("web/src/App.tsx");
  const feedbackCard = source("web/src/components/feedback-card.tsx");
  const utils = source("web/src/lib/utils.ts");
  const pageSidebar = /<PageSidebar[\s\S]*?\/>/.exec(app)?.[0] || "";

  assert.match(pageSidebar, /onOpenSettings=\{goToSettings\}/);
  assert.doesNotMatch(pageSidebar, /setActiveView\("settings"\)/);
  assert.match(app, /const feedbackEnabled = isAnalyticsEnabled\(feedback\);/);
  assert.match(feedbackCard, /const enabled = isAnalyticsEnabled\(feedback\);/);
  assert.match(
    utils,
    /return Boolean\(feedback\?\.url && feedback\.analyticsEnabled !== false\);/
  );
});
