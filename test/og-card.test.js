import assert from "node:assert/strict";
import test from "node:test";

import { OG_CARD_FILENAME, OG_CARD_HEIGHT, OG_CARD_WIDTH, renderOgCard } from "../src/og-card.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

test("renderOgCard renders a PNG for title + description + host", async () => {
  const png = await renderOgCard({
    title: "Q3 Revenue Dashboard",
    description: "Revenue up 18% quarter over quarter.",
    siteHost: "acme-reports.pages.dev"
  });
  assert.ok(isPng(png), "expected a PNG buffer");
});

test("renderOgCard handles a long title and missing description", async () => {
  const png = await renderOgCard({
    title:
      "A very long report title that has to wrap across several lines and eventually clamp " +
      "because nobody sizes their headlines for social cards",
    siteHost: "example.pages.dev"
  });
  assert.ok(isPng(png), "expected a PNG buffer");
});

test("renderOgCard returns null without a usable title", async () => {
  assert.equal(await renderOgCard({ title: "" }), null);
  assert.equal(await renderOgCard({ title: "   \n\t " }), null);
  assert.equal(await renderOgCard({}), null);
});

test("card constants match the OG contract", () => {
  assert.equal(OG_CARD_WIDTH, 1200);
  assert.equal(OG_CARD_HEIGHT, 630);
  assert.match(OG_CARD_FILENAME, /^[a-z0-9-]+\.png$/);
});
