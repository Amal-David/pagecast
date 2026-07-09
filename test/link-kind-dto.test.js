import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReportStore } from "../src/server.js";

function publication(slug, { drop = false } = {}) {
  return {
    token: `token-${slug}`,
    slug,
    label: slug,
    kind: "snapshot",
    drop,
    publicUrl: `https://pagecast.pages.dev/p/${slug}/`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revokedAt: null
  };
}

test("report DTOs explicitly classify legacy, drop, unlisted, and protected links", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-link-kind-dto-"));
  const store = createReportStore({ dataDir });
  await store.init();

  try {
    const report = await store.addUpload({
      filename: "links.html",
      content: Buffer.from("<h1>Links</h1>")
    });
    await store.commitPublication(report.id, publication("hollow-paperclip"));
    await store.commitPublication(
      report.id,
      publication(`quiet-paperclip-${"a".repeat(32)}`)
    );
    await store.commitPublication(report.id, publication("launch", { drop: true }));

    const classified = new Map(
      store.formatReport(store.get(report.id), {}).publications.map((item) => [
        item.slug,
        item.linkKind
      ])
    );
    assert.equal(classified.get("hollow-paperclip"), "legacy");
    assert.equal(classified.get(`quiet-paperclip-${"a".repeat(32)}`), "unlisted");
    assert.equal(classified.get("launch"), "drop");

    const protectedReport = await store.addUpload({
      filename: "protected.html",
      content: Buffer.from("<h1>Protected</h1>")
    });
    await store.commitPublication(
      protectedReport.id,
      publication(`protected-link-${"b".repeat(32)}`)
    );
    await store.setPasswordProtection(protectedReport.id, {
      enabled: true,
      password: "correct horse battery staple"
    });
    assert.equal(
      store.formatReport(store.get(protectedReport.id), {}).publications[0].linkKind,
      "protected"
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
