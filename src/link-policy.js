import { randomBytes } from "node:crypto";

import { generateName } from "./nameGenerator.js";

export const LINK_KINDS = Object.freeze({
  DROP: "drop",
  UNLISTED: "unlisted",
  PROTECTED: "protected",
  LEGACY: "legacy",
  UNKNOWN: "unknown"
});

export const UNLISTED_CAPABILITY_BYTES = 16;
export const UNLISTED_CAPABILITY_BITS = UNLISTED_CAPABILITY_BYTES * 8;
export const UNLISTED_CAPABILITY_HEX_LENGTH = UNLISTED_CAPABILITY_BYTES * 2;

const MAX_SLUG_LENGTH = 63;
const MAX_PREFIX_LENGTH =
  MAX_SLUG_LENGTH - UNLISTED_CAPABILITY_HEX_LENGTH - 1;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORD_ONLY_SLUG = /^[a-z]+(?:-[a-z]+)*$/;
const RESERVED_SLUGS = new Set(["", "404", "index", "p"]);
const CAPABILITY_SUFFIX = new RegExp(
  `^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([0-9a-f]{${UNLISTED_CAPABILITY_HEX_LENGTH}})$`,
  "i"
);

function normalizeMemorablePrefix(value) {
  const words = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);

  while (words.length > 1 && words.join("-").length > MAX_PREFIX_LENGTH) {
    words.pop();
  }

  let prefix = words.join("-");
  if (prefix.length > MAX_PREFIX_LENGTH) {
    prefix = prefix.slice(0, MAX_PREFIX_LENGTH).replace(/-+$/g, "");
  }
  if (!prefix || RESERVED_SLUGS.has(prefix) || !DNS_LABEL.test(prefix)) {
    throw new TypeError("A valid memorable link prefix is required.");
  }
  return prefix;
}

function capabilityHex(randomBytesImpl) {
  const generated = randomBytesImpl(UNLISTED_CAPABILITY_BYTES);
  if (!(generated instanceof Uint8Array)) {
    throw new TypeError("Capability randomness must be returned as bytes.");
  }
  const bytes = Buffer.from(generated);
  if (bytes.length !== UNLISTED_CAPABILITY_BYTES) {
    throw new TypeError(
      `Capability randomness must contain exactly ${UNLISTED_CAPABILITY_BYTES} bytes.`
    );
  }
  return bytes.toString("hex");
}

function validateDropSlug(slug) {
  if (
    !DNS_LABEL.test(slug) ||
    RESERVED_SLUGS.has(slug) ||
    slug.split("-").length > 3 ||
    CAPABILITY_SUFFIX.test(slug)
  ) {
    throw new TypeError("A drop slug must be a short memorable name.");
  }
  return slug;
}

/**
 * Generate a fresh slug under the product link policy. Drops remain short and
 * memorable. Unlisted and protected links share a memorable prefix plus an
 * independently generated 128-bit capability; protection remains separate
 * metadata/classification rather than being inferred from the URL alone.
 */
export function createLinkSlug({
  kind = LINK_KINDS.UNLISTED,
  isTaken = () => false,
  generateMemorableName = () => generateName(),
  randomBytesImpl = randomBytes,
  maxAttempts = 50
} = {}) {
  if (
    kind !== LINK_KINDS.DROP &&
    kind !== LINK_KINDS.UNLISTED &&
    kind !== LINK_KINDS.PROTECTED
  ) {
    throw new TypeError(`Unsupported link kind: ${kind}`);
  }
  if (typeof isTaken !== "function" || typeof generateMemorableName !== "function") {
    throw new TypeError("Link collision and name generators must be functions.");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const memorableName = normalizeMemorablePrefix(generateMemorableName());
    const slug =
      kind === LINK_KINDS.DROP
        ? validateDropSlug(memorableName)
        : `${memorableName}-${capabilityHex(randomBytesImpl)}`;
    if (!isTaken(slug)) {
      if (kind !== LINK_KINDS.DROP) {
        validateUnlistedSlug(slug);
      }
      return slug;
    }
  }

  throw new Error("Unable to generate a unique link slug after retries.");
}

export function inspectCapabilitySlug(slug) {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!DNS_LABEL.test(normalized) || normalized.length > MAX_SLUG_LENGTH) {
    return null;
  }
  const match = CAPABILITY_SUFFIX.exec(normalized);
  if (!match) {
    return null;
  }
  return {
    slug: normalized,
    prefix: match[1],
    capability: match[2],
    capabilityBits: match[2].length * 4
  };
}

export function validateUnlistedSlug(slug, { minimumBits = 128 } = {}) {
  const inspected = inspectCapabilitySlug(slug);
  if (!inspected || inspected.capabilityBits < minimumBits) {
    throw new TypeError(
      `An unlisted link must contain at least ${minimumBits} bits of capability entropy.`
    );
  }
  return inspected;
}

export function isLegacyWordOnlySlug(slug) {
  const normalized = String(slug || "").trim().toLowerCase();
  return (
    normalized.length <= MAX_SLUG_LENGTH &&
    WORD_ONLY_SLUG.test(normalized) &&
    !RESERVED_SLUGS.has(normalized)
  );
}

/**
 * Classify with publication metadata first: password protection is a distinct
 * access-control state, and an explicitly public drop remains a drop. URL shape
 * then distinguishes new/old capability URLs from post-v0.2 word-only links.
 */
export function classifyLinkKind({
  slug,
  drop = false,
  passwordProtected = false
} = {}) {
  if (passwordProtected) {
    return LINK_KINDS.PROTECTED;
  }
  if (drop) {
    return LINK_KINDS.DROP;
  }
  if (inspectCapabilitySlug(slug)) {
    return LINK_KINDS.UNLISTED;
  }
  if (isLegacyWordOnlySlug(slug)) {
    return LINK_KINDS.LEGACY;
  }
  return LINK_KINDS.UNKNOWN;
}
