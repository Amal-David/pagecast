import assert from "node:assert/strict";
import test from "node:test";

import {
  LINK_KINDS,
  UNLISTED_CAPABILITY_BITS,
  UNLISTED_CAPABILITY_BYTES,
  classifyLinkKind,
  createLinkSlug,
  inspectCapabilitySlug,
  isLegacyWordOnlySlug,
  validateUnlistedSlug
} from "../src/link-policy.js";

const CAPABILITY = "00112233445566778899aabbccddeeff";
const deterministicBytes = (size) => {
  assert.equal(size, UNLISTED_CAPABILITY_BYTES);
  return Buffer.from(CAPABILITY, "hex");
};

test("unlisted links combine a human prefix with exactly 128 random bits", () => {
  const slug = createLinkSlug({
    kind: LINK_KINDS.UNLISTED,
    generateMemorableName: () => "hollow-paperclip",
    randomBytesImpl: deterministicBytes
  });

  assert.equal(slug, `hollow-paperclip-${CAPABILITY}`);
  assert.match(slug, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  assert.ok(slug.length <= 63);
  assert.deepEqual(validateUnlistedSlug(slug), {
    slug,
    prefix: "hollow-paperclip",
    capability: CAPABILITY,
    capabilityBits: UNLISTED_CAPABILITY_BITS
  });
  assert.equal(classifyLinkKind({ slug }), LINK_KINDS.UNLISTED);
});

test("capability generation rejects fewer than 16 random bytes", () => {
  assert.throws(
    () =>
      createLinkSlug({
        generateMemorableName: () => "hollow-paperclip",
        randomBytesImpl: () => Buffer.alloc(15)
      }),
    /exactly 16 bytes/i
  );
  assert.throws(
    () => validateUnlistedSlug(`hollow-paperclip-${"a".repeat(30)}`),
    /at least 128 bits/i
  );
});

test("drops stay short, memorable, and capability-free", () => {
  const slug = createLinkSlug({
    kind: LINK_KINDS.DROP,
    generateMemorableName: () => "calm-comet",
    randomBytesImpl: () => {
      throw new Error("drops must not request capability bytes");
    }
  });

  assert.equal(slug, "calm-comet");
  assert.equal(inspectCapabilitySlug(slug), null);
  assert.equal(classifyLinkKind({ slug, drop: true }), LINK_KINDS.DROP);
});

test("protected classification remains distinct from URL capability shape", () => {
  const slug = createLinkSlug({
    kind: LINK_KINDS.PROTECTED,
    generateMemorableName: () => "quiet-aurora",
    randomBytesImpl: deterministicBytes
  });

  assert.equal(classifyLinkKind({ slug }), LINK_KINDS.UNLISTED);
  assert.equal(
    classifyLinkKind({ slug, passwordProtected: true }),
    LINK_KINDS.PROTECTED
  );
});

test("existing word-only slugs remain recognizable legacy links", () => {
  for (const slug of [
    "hollow-paperclip",
    "hollow-paperclip-beneath-quiet-static",
    "goal"
  ]) {
    assert.equal(isLegacyWordOnlySlug(slug), true, slug);
    assert.equal(classifyLinkKind({ slug }), LINK_KINDS.LEGACY, slug);
  }

  const oldCapabilitySlug = `v1-${CAPABILITY}`;
  assert.equal(classifyLinkKind({ slug: oldCapabilitySlug }), LINK_KINDS.UNLISTED);
  assert.equal(isLegacyWordOnlySlug(oldCapabilitySlug), false);
});

test("capability collisions re-roll without changing the human policy", () => {
  const capabilities = ["00".repeat(16), "11".repeat(16)];
  const slug = createLinkSlug({
    generateMemorableName: () => "calm-comet",
    randomBytesImpl: () => Buffer.from(capabilities.shift(), "hex"),
    isTaken: (candidate) => candidate.endsWith("00".repeat(16))
  });

  assert.equal(slug, `calm-comet-${"11".repeat(16)}`);
});
