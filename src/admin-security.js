import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_HOSTNAME = "pagecast.localhost";
export const PAGECAST_EXTENSION_ID = "adlpjcmhkaekabmcaalebllkegmojncf";
export const PAGECAST_EXTENSION_ID_OVERRIDE_ENV = "PAGECAST_EXTENSION_ID_OVERRIDE";

export const ADMIN_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const EXTENSION_API_ROUTES = new Set([
  "/api/session",
  "/api/status",
  "/api/publish-local"
]);

function adminPolicyError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

// DNS-rebinding defense for the admin server. The API can run shell commands,
// so an absent or non-loopback Host is never trusted merely because the socket
// itself is bound locally.
export function isLoopbackHostHeader(hostHeader, bindHost, allowedHosts = []) {
  if (!hostHeader) {
    return false;
  }
  let hostname = String(hostHeader);
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(hostname);
  if (ipv6) {
    // Bracketed IPv6: "[::1]:4173" -> "::1".
    hostname = ipv6[1];
  } else if ((hostname.match(/:/g) || []).length <= 1) {
    // "host:port" or bare "host" — strip a single trailing ":port" only. A value
    // with more than one colon is a bare IPv6 literal (e.g. "::1") and is left
    // intact rather than truncated at its first colon.
    const colon = hostname.lastIndexOf(":");
    if (colon > -1) {
      hostname = hostname.slice(0, colon);
    }
  }
  hostname = hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1"
  ) {
    return true;
  }
  // The entire 127.0.0.0/8 block is loopback.
  if (isIP(hostname) === 4 && hostname.startsWith("127.")) {
    return true;
  }
  if (
    allowedHosts.some((allowedHost) => {
      const allowed = String(allowedHost || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
      return hostname === allowed && isLoopbackBindHost(allowed);
    })
  ) {
    return true;
  }
  return false;
}

export function isLoopbackBindHost(host) {
  const hostname = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."))
  );
}

export function isWildcardBindHost(host) {
  const hostname = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "0.0.0.0" || hostname === "::";
}

export function assertSafeAdminBind(host, { allowLoopbackProxy = false } = {}) {
  if (isLoopbackBindHost(host)) {
    return;
  }
  if (isWildcardBindHost(host) && allowLoopbackProxy === true) {
    return;
  }
  if (isWildcardBindHost(host)) {
    throw adminPolicyError(
      "Refusing to bind the Pagecast admin server to a wildcard address without explicit loopback-proxy mode. Set PAGECAST_ALLOW_LOOPBACK_PROXY=1 only when the published host port is restricted to loopback.",
      400
    );
  }
  throw adminPolicyError(
    `Refusing to bind the Pagecast admin server to non-loopback host ${host}. Pagecast does not expose its privileged admin API on routable interfaces.`,
    400
  );
}

// Reflect only the packaged Pagecast extension. A syntactically valid extension
// origin is not identity: trusting every extension would let an unrelated one
// ask Pagecast to read and publish a local file. Unpacked development builds may
// opt into one additional exact ID through an explicit environment override.
export function extensionCorsOrigin(originHeader, { env = process.env } = {}) {
  if (typeof originHeader !== "string") return null;
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(originHeader);
  if (!match) return null;

  const developmentId = String(env?.[PAGECAST_EXTENSION_ID_OVERRIDE_ENV] || "")
    .trim()
    .toLowerCase();
  const developmentIdAllowed = /^[a-p]{32}$/.test(developmentId);
  return match[1] === PAGECAST_EXTENSION_ID ||
    (developmentIdAllowed && match[1] === developmentId)
    ? originHeader
    : null;
}

export function requestOrigin(req) {
  try {
    return new URL(`http://${req.headers.host}`).origin;
  } catch {
    return "";
  }
}

export function tokensMatch(actual, expected) {
  if (
    typeof actual !== "string" ||
    typeof expected !== "string" ||
    actual.length === 0 ||
    expected.length === 0
  ) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
