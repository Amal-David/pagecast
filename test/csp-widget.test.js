import assert from "node:assert/strict";
import test from "node:test";

import { allowCspOrigin, injectFeedbackWidget } from "../src/server.js";
import { markdownToHtml } from "../src/markdown.js";

const WORKER = "https://feedback.example.workers.dev";
const widgetArgs = { url: WORKER, slug: "a-page", publicationId: "a-page" };

// A markdown document also carries a viewport meta with its own `content=`,
// so the policy must be read from the CSP tag specifically.
function policyOf(html) {
  const tag = html.match(/<meta\b[^>]*http-equiv\s*=\s*"Content-Security-Policy"[^>]*>/i);
  assert.ok(tag, "expected a Content-Security-Policy meta tag");
  return tag[0].match(/content\s*=\s*"((?:[^"])*)"/i)[1];
}

// The regression this file exists for: a markdown-published page carries
// `script-src 'none'`, so the injected widget never ran and never beaconed.
test("markdown documents ship a CSP that would block an injected script", () => {
  const html = markdownToHtml("# Title\n\nBody.", { title: "Title" });
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /connect-src/, "connect-src falls back to default-src 'none'");
});

test("injecting the widget into a markdown page permits its origin to run and beacon", () => {
  const injected = injectFeedbackWidget(markdownToHtml("# T\n\nBody.", { title: "T" }), widgetArgs);
  const policy = policyOf(injected);

  assert.doesNotMatch(policy, /script-src 'none'/, "'none' must be replaced, never appended to");
  assert.match(policy, new RegExp(`script-src ${WORKER}`));
  assert.match(policy, new RegExp(`connect-src ${WORKER}`), "the beacon fetch needs connect-src");
  assert.match(injected, new RegExp(`<script src="${WORKER}/widget.js"`));
});

test("unrelated directives survive untouched", () => {
  const injected = injectFeedbackWidget(markdownToHtml("# T", { title: "T" }), widgetArgs);
  const policy = policyOf(injected);
  // Guards the call site as well: widening must have happened here too.
  assert.match(policy, new RegExp(`script-src ${WORKER}`));
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /style-src 'unsafe-inline'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
});

test("HTML documents without a meta CSP are returned untouched", () => {
  const plain = "<html><body><p>hi</p></body></html>";
  assert.equal(allowCspOrigin(plain, WORKER), plain);
  const injected = injectFeedbackWidget(plain, widgetArgs);
  assert.doesNotMatch(injected, /Content-Security-Policy/);
  assert.match(injected, /widget\.js/);
});

test("widening is idempotent", () => {
  const once = allowCspOrigin(markdownToHtml("# T", { title: "T" }), WORKER);
  const twice = allowCspOrigin(once, WORKER);
  assert.equal(twice, once);
  assert.equal((twice.match(new RegExp(WORKER, "g")) || []).length, 2, "one per directive, not four");
});

test("an existing source list is appended to rather than replaced", () => {
  const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">`;
  const out = allowCspOrigin(html, WORKER);
  assert.match(out, new RegExp(`script-src 'self' ${WORKER}`));
});

test("a blank origin changes nothing", () => {
  const html = markdownToHtml("# T", { title: "T" });
  assert.equal(allowCspOrigin(html, ""), html);
  assert.equal(allowCspOrigin(html, "   "), html);
});
