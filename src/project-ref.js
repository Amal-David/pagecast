const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWNERSHIP_MARKER_FORMAT = "pagecast-project-owner";
const OWNERSHIP_MARKER_VERSION = 1;
const OWNERSHIP_MODES = new Set(["publications", "direct"]);

export const PAGECAST_PROJECT_MARKER_FILE = "__pagecast/ownership.json";

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError("ProjectRef base URL must be a valid HTTP or HTTPS URL.");
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("ProjectRef base URL must be a valid HTTP or HTTPS URL.");
  }
  return parsed.origin;
}

/**
 * Return the canonical target identity and its mutable production-origin metadata.
 * Neither the project identity nor a default base URL is inferred from a hostname.
 */
export function normalizeProjectRef(value) {
  const accountId = String(value?.accountId || "").trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new TypeError("Cloudflare account ID must be 32 hex characters.");
  }

  const projectName = String(value?.projectName || "").trim().toLowerCase();
  if (!PROJECT_NAME_PATTERN.test(projectName)) {
    throw new TypeError("Cloudflare Pages project name must be a valid lowercase slug.");
  }

  return {
    accountId,
    projectName,
    baseUrl: normalizeBaseUrl(value?.baseUrl)
  };
}

function normalizeExplicitStoredRef(value, baseUrl) {
  const accountId = String(value?.accountId || "").trim();
  const projectName = String(value?.projectName || "").trim();
  if (!accountId || !projectName) {
    return null;
  }
  return normalizeProjectRef({ accountId, projectName, baseUrl });
}

/**
 * Normalize only identity that was actually persisted.
 *
 * Legacy publication fields are intentionally opt-in so callers doing migration
 * can distinguish attributable records from records that need quarantine.
 */
export function normalizeStoredProjectRef(value, { allowLegacy = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  if (value.projectRef !== undefined) {
    if (!value.projectRef || typeof value.projectRef !== "object" || Array.isArray(value.projectRef)) {
      return null;
    }
    return normalizeExplicitStoredRef(
      value.projectRef,
      value.projectRef.baseUrl === undefined ? value.baseUrl : value.projectRef.baseUrl
    );
  }

  if (value.accountId !== undefined || value.projectName !== undefined) {
    return normalizeExplicitStoredRef(value, value.baseUrl);
  }

  if (allowLegacy !== true) {
    return null;
  }

  const accountId = String(value.pagesAccountId || "").trim();
  const projectName = String(value.pagesProjectName || "").trim();
  if (!accountId || !projectName) {
    return null;
  }
  return normalizeProjectRef({
    accountId,
    projectName,
    baseUrl: value.pagesBaseUrl
  });
}

export function projectRefEquals(left, right) {
  try {
    const normalizedLeft = normalizeProjectRef(left);
    const normalizedRight = normalizeProjectRef(right);
    return (
      normalizedLeft.accountId === normalizedRight.accountId &&
      normalizedLeft.projectName === normalizedRight.projectName
    );
  } catch {
    return false;
  }
}

export function projectRefFilesystemKey(value) {
  const { accountId, projectName } = normalizeProjectRef(value);
  return `${accountId}--${projectName}`;
}

function normalizeOwnerId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Pagecast owner ID must be non-empty.");
  }
  return value.trim();
}

function normalizeOwnershipMode(value) {
  const mode = String(value || "").trim();
  if (!OWNERSHIP_MODES.has(mode)) {
    throw new TypeError("Pagecast ownership mode must be publications or direct.");
  }
  return mode;
}

function normalizeOwnership(value) {
  return {
    ownerId: normalizeOwnerId(value?.ownerId),
    mode: normalizeOwnershipMode(value?.mode),
    projectRef: normalizeProjectRef(value?.projectRef || value)
  };
}

export function encodeProjectOwnershipMarker(value) {
  const { ownerId, mode, projectRef } = normalizeOwnership(value);
  return `${JSON.stringify(
    {
      format: OWNERSHIP_MARKER_FORMAT,
      version: OWNERSHIP_MARKER_VERSION,
      ownerId,
      mode,
      accountId: projectRef.accountId,
      projectName: projectRef.projectName,
      baseUrl: projectRef.baseUrl
    },
    null,
    2
  )}\n`;
}

export function parseOwnershipMarker(serialized) {
  let marker;
  try {
    marker = JSON.parse(String(serialized));
  } catch {
    throw new TypeError("Invalid Pagecast project ownership marker.");
  }

  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.format !== OWNERSHIP_MARKER_FORMAT ||
    marker.version !== OWNERSHIP_MARKER_VERSION
  ) {
    throw new TypeError("Invalid Pagecast project ownership marker.");
  }

  try {
    return normalizeOwnership(marker);
  } catch {
    throw new TypeError("Invalid Pagecast project ownership marker.");
  }
}

export function validateOwnershipMarker(serialized, expectedOwnership) {
  try {
    const actual = parseOwnershipMarker(serialized);
    const expected = normalizeOwnership(expectedOwnership);
    return (
      actual.ownerId === expected.ownerId &&
      actual.mode === expected.mode &&
      projectRefEquals(actual.projectRef, expected.projectRef)
    );
  } catch {
    return false;
  }
}
