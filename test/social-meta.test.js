import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCloudflarePagesPublisher,
  createConfigStore,
  createReportStore,
  extractDescription,
  extractTitle,
  injectSocialMeta
} from "../src/server.js";
import { OG_CARD_FILENAME } from "../src/og-card.js";

// --- unit: injectSocialMeta -------------------------------------------------

test("injectSocialMeta adds OG + Twitter tags inside <head>", () => {
  const html = "<!doctype html><html><head><title>X</title></head><body><h1>Hi</h1></body></html>";
  const out = injectSocialMeta(html, {
    title: "My Report",
    description: "A summary",
    url: "https://x.pages.dev/p/abc/",
    image: "https://img/og.png",
    siteName: "Pagecast"
  });
  assert.match(out, /<meta property="og:title" content="My Report">/);
  assert.match(out, /<meta property="og:description" content="A summary">/);
  assert.match(out, /<meta property="og:url" content="https:\/\/x\.pages\.dev\/p\/abc\/">/);
  assert.match(out, /<meta property="og:image" content="https:\/\/img\/og\.png">/);
  assert.match(out, /<meta property="og:site_name" content="Pagecast">/);
  assert.match(out, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(out.indexOf("og:title") < out.indexOf("</head>"), "tags go before </head>");
});

test("injectSocialMeta omits image/site_name when not provided (white-label)", () => {
  const out = injectSocialMeta("<head></head><body></body>", { title: "T", url: "https://u/" });
  assert.match(out, /og:title/);
  assert.doesNotMatch(out, /og:image/);
  assert.doesNotMatch(out, /og:site_name/);
});

test("injectSocialMeta emits image dimensions only alongside an image", () => {
  const withImage = injectSocialMeta("<head></head>", {
    title: "T",
    image: "https://img/og.png",
    imageWidth: 1200,
    imageHeight: 630
  });
  assert.match(withImage, /<meta property="og:image:width" content="1200">/);
  assert.match(withImage, /<meta property="og:image:height" content="630">/);
  const withoutImage = injectSocialMeta("<head></head>", {
    title: "T",
    imageWidth: 1200,
    imageHeight: 630
  });
  assert.doesNotMatch(withoutImage, /og:image/);
});

test("injectSocialMeta leaves a doc that already has its own og: meta untouched", () => {
  const html = '<head><meta property="og:title" content="Author"></head>';
  assert.equal(injectSocialMeta(html, { title: "Ours", url: "https://x/" }), html);
});

test("injectSocialMeta is a no-op when there is no usable content", () => {
  const html = "<head></head>";
  assert.equal(injectSocialMeta(html, {}), html);
});

test("injectSocialMeta escapes attribute-breaking characters", () => {
  const out = injectSocialMeta("<head></head>", { title: 'A "quote" & <tag>' });
  assert.match(out, /content="A &quot;quote&quot; &amp; &lt;tag&gt;"/);
  assert.doesNotMatch(out, /content="A "quote/);
});

test("injectSocialMeta falls back to before <body> then prepend when no </head>", () => {
  assert.match(injectSocialMeta("<body><h1>x</h1></body>", { title: "T" }), /og:title[\s\S]*<body>/);
  assert.match(injectSocialMeta("<h1>frag</h1>", { title: "T" }), /^[\s\S]*og:title[\s\S]*<h1>frag/);
});

// --- unit: extractors -------------------------------------------------------

test("extractTitle prefers a meaningful <title>, else the fallback, and decodes entities", () => {
  assert.equal(extractTitle("<title>Q3 Revenue</title>", "fallback"), "Q3 Revenue");
  assert.equal(extractTitle("<title>index</title>", "Q3 Revenue Dashboard"), "Q3 Revenue Dashboard");
  assert.equal(extractTitle("<h1>no title</h1>", "Fallback Name"), "Fallback Name");
  assert.equal(extractTitle("<title>Tom &amp; Jerry</title>", "x"), "Tom & Jerry");
});

test("extractDescription prefers meta description, else first paragraph text", () => {
  assert.equal(extractDescription('<meta name="description" content="Meta desc">'), "Meta desc");
  assert.equal(extractDescription("<p>First <b>para</b> text.</p><p>second</p>"), "First para text.");
  assert.equal(extractDescription("<div>no para here</div>"), "");
});

test("extractDescription keeps apostrophes (closing quote matches the opener)", () => {
  // Regression for the bug Devin caught on PR #3: a double-quoted value with an
  // apostrophe must not truncate at the apostrophe ("We" instead of "We're …").
  assert.equal(
    extractDescription('<meta name="description" content="We\'re up 18% this quarter">'),
    "We're up 18% this quarter"
  );
  assert.equal(
    extractDescription("<meta name='description' content='She said \"hi\" today'>"),
    'She said "hi" today'
  );
});

// --- integration: publish stages the OG block ------------------------------

function fakeDeploySpawn(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", null, "SIGTERM");
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from("https://abcdef123456.pagecast.pages.dev/"));
    child.emit("exit", 0, null);
  });
  return child;
}

async function publishOnce({ badge }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-og-"));
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, "index.html"),
    '<!doctype html><html><head><title>Quarterly Update</title>' +
      '<meta name="description" content="Revenue up 18%."></head><body><h1>Q</h1></body></html>'
  );

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adoptExisting: true
  });
  const store = createReportStore({ dataDir });
  await store.init();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploySpawn,
    timeoutMs: 5000,
    getBadge: () => badge,
    getProtectedPublications: () => store.protectedPublicationManifest(),
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getOwnerId: () => configStore.getOwnerId(),
    isTargetManaged: (projectRef) => configStore.isTargetManaged(projectRef),
    claimTargetManaged: (projectRef) => configStore.claimManagedTarget(projectRef)
  });

  const report = await store.addPath(path.join(reportDir, "index.html"));
  const draft = store.draftPublication(report.id, { kind: "snapshot" });
  Object.assign(draft.publication, {
    pagesProjectName: configStore.get().pages.projectName,
    pagesAccountId: configStore.get().pages.accountId,
    pagesBaseUrl: configStore.get().pages.baseUrl,
    projectRef: configStore.get().pages
  });
  draft.publication.publicUrl = await publisher.publish({
    report: draft.report,
    publication: draft.publication,
    pagesConfig: configStore.get().pages
  });
  await store.commitPublication(report.id, draft.publication);

  const slug = draft.publication.slug || draft.publication.token;
  const stagedDir = path.join(publisher.siteRoot, "p", slug);
  const staged = await fs.readFile(path.join(stagedDir, "index.html"), "utf8");
  return { staged, stagedDir, slug, baseUrl: configStore.get().pages.baseUrl };
}

test("publishing injects per-report OG meta with a locally rendered card (badge on)", async () => {
  const { staged, stagedDir, slug, baseUrl } = await publishOnce({ badge: true });
  assert.match(staged, /<meta property="og:title" content="Quarterly Update">/);
  assert.match(staged, /<meta property="og:description" content="Revenue up 18%\.">/);
  assert.ok(staged.includes(`<meta property="og:url" content="${baseUrl}/p/${slug}/">`));
  assert.ok(
    staged.includes(`<meta property="og:image" content="${baseUrl}/p/${slug}/${OG_CARD_FILENAME}">`),
    "og:image should point at the per-page card deployed with the snapshot"
  );
  assert.match(staged, /<meta property="og:image:width" content="1200">/);
  assert.match(staged, /<meta property="og:image:height" content="630">/);
  assert.match(staged, /<meta property="og:site_name" content="Pagecast">/);
  const card = await fs.readFile(path.join(stagedDir, OG_CARD_FILENAME));
  assert.equal(card.subarray(1, 4).toString("latin1"), "PNG", "card must be staged as a PNG");
});

test("white-label publish keeps OG text but omits the Pagecast image", async () => {
  const { staged, stagedDir } = await publishOnce({ badge: false });
  assert.match(staged, /og:title/);
  assert.doesNotMatch(staged, /og:image/);
  assert.doesNotMatch(staged, /og:site_name/);
  await assert.rejects(fs.readFile(path.join(stagedDir, OG_CARD_FILENAME)), /ENOENT/);
});
