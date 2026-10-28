import assert from "node:assert/strict";
import test from "node:test";

import { allowGeneratedCspOrigin, injectFeedbackWidget } from "../src/server.js";
import {
  MARKDOWN_DOCUMENT_CSP,
  MARKDOWN_DOCUMENT_CSP_TAG,
  markdownToHtml
} from "../src/markdown.js";

const WORKER = "https://feedback.example.workers.dev";
const widgetArgs = { url: WORKER, slug: "a-page", publicationId: "a-page" };
const doc = () => markdownToHtml("# Title\n\nBody.", { title: "Title" });
const meta = (policy) => `<meta http-equiv="Content-Security-Policy" content="${policy}">`;

// Read the policy from the CSP tag specifically — a markdown document also
// carries a viewport meta with its own `content=`.
function policyOf(html) {
  const tag = html.match(/<meta\b[^>]*http-equiv\s*=\s*"Content-Security-Policy"[^>]*>/i);
  assert.ok(tag, "expected a Content-Security-Policy meta tag");
  return tag[0].match(/content\s*=\s*"([^"]*)"/i)[1];
}

// --- the premise this whole file exists for -------------------------------
test("generated markdown documents ship a CSP that blocks an injected script", () => {
  const html = doc();
  assert.ok(html.includes(MARKDOWN_DOCUMENT_CSP_TAG), "the exported tag must be what is emitted");
  assert.ok(MARKDOWN_DOCUMENT_CSP.includes("script-src 'none'"));
  assert.ok(MARKDOWN_DOCUMENT_CSP.includes("default-src 'none'"));
  assert.ok(!MARKDOWN_DOCUMENT_CSP.includes("connect-src"), "connect-src inherits default-src 'none'");
});

// --- the fix ---------------------------------------------------------------
test("injecting the widget widens both directives the widget needs", () => {
  const policy = policyOf(injectFeedbackWidget(doc(), widgetArgs));
  assert.ok(!policy.includes("script-src 'none'"), "'none' must be replaced, never appended to");
  assert.ok(policy.includes(`script-src ${WORKER}`));
  assert.ok(policy.includes(`connect-src ${WORKER}`), "the beacon fetch needs connect-src");
});

test("every other directive survives byte-identical", () => {
  const policy = policyOf(injectFeedbackWidget(doc(), widgetArgs));
  for (const directive of [
    "default-src 'none'", "img-src * data:", "style-src 'unsafe-inline'",
    "font-src * data:", "base-uri 'none'", "form-action 'none'"
  ]) {
    assert.ok(policy.includes(directive), `lost: ${directive}`);
  }
});

test("widening is idempotent", () => {
  const once = allowGeneratedCspOrigin(doc(), WORKER);
  assert.equal(allowGeneratedCspOrigin(once, WORKER), once);
});

test("every generated tag in a document is rewritten, not just the first", () => {
  const two = `${MARKDOWN_DOCUMENT_CSP_TAG}\n${MARKDOWN_DOCUMENT_CSP_TAG}`;
  const out = allowGeneratedCspOrigin(two, WORKER);
  assert.equal(out.split(`script-src ${WORKER}`).length - 1, 2);
  assert.ok(!out.includes("script-src 'none'"));
});

// --- what it must NEVER touch ---------------------------------------------
// Rewriting a CSP generically is a trap, so this only ever matches Pagecast's
// own generated tag. Each case below is a policy a general rewriter gets wrong.
test("an author's own CSP is never modified", () => {
  const cases = [
    // A Map keyed by directive name keeps the LAST duplicate; CSP keeps the FIRST,
    // so rewriting this turns a blocking policy into a wildcard.
    "script-src 'none'; script-src *",
    // Dropping the whole list on seeing 'none' would silently remove 'self'.
    "script-src 'self' 'none'",
    // Host sources are ignored under 'strict-dynamic' — widening achieves nothing
    // and relaxes the policy for no benefit.
    "default-src 'none'; script-src 'nonce-abc' 'strict-dynamic'",
    // script-src-elem outranks script-src for <script> elements.
    "default-src 'none'; script-src 'none'; script-src-elem 'none'",
    // An author who deliberately requires a nonce must keep requiring one.
    "default-src 'self'; script-src 'nonce-xyz'"
  ];
  for (const policy of cases) {
    assert.equal(allowGeneratedCspOrigin(meta(policy), WORKER), meta(policy), `modified: ${policy}`);
  }
});

test("an author page still receives the widget even though its CSP is left alone", () => {
  const page = `<html><head>${meta("default-src 'self'; script-src 'nonce-xyz'")}</head><body></body></html>`;
  const out = injectFeedbackWidget(page, widgetArgs);
  assert.equal(policyOf(out), "default-src 'self'; script-src 'nonce-xyz'");
  assert.ok(out.includes(`${WORKER}/widget.js`));
});

test("documents with no CSP at all are returned untouched", () => {
  const plain = "<html><body><p>hi</p></body></html>";
  assert.equal(allowGeneratedCspOrigin(plain, WORKER), plain);
  const out = injectFeedbackWidget(plain, widgetArgs);
  assert.ok(!out.includes("Content-Security-Policy"));
  assert.ok(out.includes("widget.js"));
});

// --- origin validation -----------------------------------------------------
// A CSP source expression is space-delimited inside a quoted attribute, so an
// origin carrying a separator could add directives or escape the attribute.
test("a hostile origin widens nothing at all", () => {
  const html = doc();
  const hostile = [
    'https://ok.dev; script-src *',      // directive injection
    'https://ok.dev" onload="alert(1)',  // attribute escape
    "https://ok.dev' ",                  // stray quote in an otherwise legal host
    'https://ok.dev>',                   // tag escape
    "https://ok.dev 'unsafe-inline'",    // source-expression smuggling
    'https://ok.dev\n; default-src *',   // newline separator
    '*',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://ok.dev',                      // non-http scheme
    'not a url',
    '//protocol-relative.dev',
    '',
    // CSP3: `host-char = ALPHA / DIGIT / "-"`, so a bracketed IPv6 literal is not
    // a valid host-source, and of the IPv4 literals that match the grammar the
    // spec notes only 127.0.0.1 actually matches a URL. Writing either would
    // emit a directive that silently never matches.
    'https://[::1]:8443',
    'http://192.168.1.10:8787',
    'https://10.0.0.5',
    'http://0.0.0.0:8080'
  ];
  for (const origin of hostile) {
    assert.equal(allowGeneratedCspOrigin(html, origin), html, `widened for: ${JSON.stringify(origin)}`);
  }
});

test("legitimate origins are accepted and normalised to scheme://host[:port]", () => {
  const p = (origin) => policyOf(allowGeneratedCspOrigin(doc(), origin));
  assert.ok(p("https://a.workers.dev").includes("script-src https://a.workers.dev;"));
  assert.ok(p("http://localhost:4599").includes("script-src http://localhost:4599;"));
  assert.ok(p("http://127.0.0.1:4599").includes("script-src http://127.0.0.1:4599;"),
    "127.0.0.1 is the one IP literal CSP3 says actually matches");
  // A trailing slash or path collapses to the origin, which covers the whole host.
  assert.ok(p("https://a.workers.dev/").includes("script-src https://a.workers.dev;"));
  assert.ok(p("https://a.workers.dev/base").includes("script-src https://a.workers.dev;"));
});
