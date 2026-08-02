// Direct Cloudflare REST access for the one capability Wrangler does not expose.
//
// Every other remote operation in Pagecast goes through the Wrangler gateway,
// which also owns credentials. Custom domains have no Wrangler subcommand at
// any 4.x version — `wrangler pages` stops at deploy/project/deployment/secret
// and `wrangler pages project` at list/create/delete — so managing them means
// calling api.cloudflare.com directly.
//
// This module is deliberately narrow: it speaks only the Pages Domains
// endpoints, owns no state, and never persists or logs a token. The required
// scope is `pages:write`, which the base grant in wrangler-gateway.js already
// requests, so this adds no new consent surface.
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";

import { appError } from "./app-error.js";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_API_TIMEOUT_MS = 15000;

// Token sources, most explicit first. `manual` is not a token — it is the
// signal that the caller must fall back to guided setup.
export const TOKEN_SOURCE_ENV = "api-token";
export const TOKEN_SOURCE_WRANGLER = "wrangler-oauth";
export const TOKEN_SOURCE_NONE = "manual";

// The Pages Domains endpoints report progress through these. Only `active`
// means the hostname actually serves traffic with a valid certificate.
export const DOMAIN_STATUS_ACTIVE = "active";
const KNOWN_DOMAIN_STATUSES = new Set([
  "initializing",
  "pending",
  "active",
  "deactivated",
  "blocked",
  "error"
]);

// Used only to phrase DNS guidance, never to reject a hostname. Cloudflare is
// the authority on whether a domain can be added; a local heuristic that
// blocked the call would be wrong for every suffix missing from this list.
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.cn",
  "com.mx",
  "co.nz",
  "co.za",
  "co.in",
  "com.sg",
  "com.tr"
]);

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Accept what a person would type — a bare hostname, a pasted URL, a trailing
 * dot — and return the lowercase hostname Cloudflare expects. Throws rather
 * than silently normalizing something that was never a hostname.
 */
export function normalizeCustomDomainName(value) {
  let raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    throw appError("A custom domain is required.", 400);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      throw appError(`${value} is not a valid domain.`, 400);
    }
  }
  raw = raw.replace(/\/.*$/, "").replace(/\.$/, "");
  if (raw.includes(":")) {
    throw appError("A custom domain must not include a port.", 400);
  }
  if (raw.endsWith(".pages.dev")) {
    throw appError(
      "pages.dev hostnames are assigned by Cloudflare and cannot be added as custom domains.",
      400
    );
  }
  const labels = raw.split(".");
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL.test(label))) {
    throw appError(`${value} is not a valid domain.`, 400);
  }
  return raw;
}

/**
 * Apex vs subdomain decides which setup instructions to print, because
 * Cloudflare treats them differently: a subdomain only needs a CNAME at
 * whatever DNS provider already hosts it, while an apex domain must be a zone
 * on the same Cloudflare account (nameservers delegated to Cloudflare).
 *
 * This is a heuristic for guidance only — see MULTI_LABEL_PUBLIC_SUFFIXES.
 */
export function classifyDomain(domain) {
  const name = normalizeCustomDomainName(domain);
  const labels = name.split(".");
  if (labels.length === 2) {
    return { name, kind: "apex" };
  }
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length === 3 && MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) {
    return { name, kind: "apex" };
  }
  return { name, kind: "subdomain" };
}

/**
 * The DNS the operator has to create, and the constraint they cannot work
 * around. Returned as data so the CLI, the dashboard, and MCP all render the
 * same instructions rather than each inventing their own copy.
 */
export function describeDnsInstructions(domain, projectHost) {
  const { name, kind } = classifyDomain(domain);
  const target = String(projectHost || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (kind === "apex") {
    return {
      name,
      kind,
      record: null,
      requiresCloudflareZone: true,
      instructions:
        `${name} is an apex domain. Cloudflare can only serve a Pages apex domain when ` +
        `the domain is a zone on the same Cloudflare account — add ${name} to that ` +
        `account and point its nameservers at Cloudflare. Cloudflare then creates the ` +
        `DNS record itself. A subdomain such as docs.${name} has no such requirement.`
    };
  }
  const [host, ...rest] = name.split(".");
  return {
    name,
    kind,
    record: { type: "CNAME", name: host, zone: rest.join("."), value: target },
    requiresCloudflareZone: false,
    instructions:
      `Create this record at whichever DNS provider hosts ${rest.join(".")}:\n` +
      `  CNAME  ${host}  ->  ${target}\n` +
      `Cloudflare issues the certificate once the record resolves.`
  };
}

/**
 * Candidate paths for Wrangler's OAuth config, in the order Wrangler itself
 * resolves them: an explicit home, then the legacy ~/.wrangler directory
 * (which Wrangler prefers whenever it exists), then the XDG-compliant path.
 *
 * The file format is Wrangler's private business, so every consumer of this
 * treats "not found" as an ordinary outcome rather than an error.
 */
export function wranglerConfigCandidates({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir()
} = {}) {
  const candidates = [];
  const wranglerHome = String(env?.WRANGLER_HOME || "").trim();
  if (wranglerHome) {
    candidates.push(path.join(wranglerHome, "config", "default.toml"));
  }
  candidates.push(path.join(homedir, ".wrangler", "config", "default.toml"));

  const xdgConfigHome = String(env?.XDG_CONFIG_HOME || "").trim();
  if (xdgConfigHome) {
    candidates.push(path.join(xdgConfigHome, ".wrangler", "config", "default.toml"));
  } else if (platform === "darwin") {
    candidates.push(
      path.join(homedir, "Library", "Preferences", ".wrangler", "config", "default.toml")
    );
  } else if (platform === "win32") {
    const appData = String(env?.APPDATA || "").trim() || path.join(homedir, "AppData", "Roaming");
    candidates.push(path.join(appData, ".wrangler", "config", "default.toml"));
  } else {
    candidates.push(path.join(homedir, ".config", ".wrangler", "config", "default.toml"));
  }
  return candidates;
}

/**
 * Pull just `oauth_token` out of Wrangler's config. A targeted read rather
 * than a TOML parse: Pagecast ships two runtime dependencies and this is not
 * worth a third, and everything else in that file is Wrangler's to change.
 */
export function parseWranglerOAuthToken(source) {
  const match = String(source || "").match(/^\s*oauth_token\s*=\s*"([^"\n]*)"/m);
  const token = match ? match[1].trim() : "";
  return token || "";
}

/**
 * Wrangler's OAuth tokens live about an hour, so a stored token is expired far
 * more often than not. Read the expiry alongside the token so we can refresh
 * only when it is actually needed — invoking Wrangler costs seconds.
 */
export function parseWranglerCredentials(source) {
  const token = parseWranglerOAuthToken(source);
  const match = String(source || "").match(/^\s*expiration_time\s*=\s*"([^"\n]*)"/m);
  const expiresAt = match ? Date.parse(match[1]) : Number.NaN;
  return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}

// Refresh a little early rather than racing the expiry mid-request.
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export function isWranglerTokenUsable(credentials, now = Date.now()) {
  if (!credentials?.token) return false;
  // An absent expiry is Wrangler's shape for a non-expiring credential.
  if (credentials.expiresAt === null) return true;
  return credentials.expiresAt - TOKEN_EXPIRY_SKEW_MS > now;
}

/**
 * Resolve a bearer token, most explicit source first.
 *
 * 1. CLOUDFLARE_API_TOKEN — the documented, stable path (.env.example, Docker).
 * 2. Wrangler's OAuth token — already carries `pages:write`. Wrangler renews it
 *    as a side effect of being invoked, so an expired token triggers one
 *    `refreshSession` call and a re-read rather than a failure.
 * 3. Nothing — the caller falls back to guided manual setup. This is a normal
 *    outcome, not a failure, so it never throws.
 */
export async function resolveCloudflareApiToken({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  readFile = (file) => fsPromises.readFile(file, "utf8"),
  refreshSession = null,
  now = Date.now()
} = {}) {
  const explicit = String(env?.CLOUDFLARE_API_TOKEN || "").trim();
  if (explicit) {
    return { token: explicit, source: TOKEN_SOURCE_ENV };
  }

  const candidates = wranglerConfigCandidates({ env, platform, homedir });
  const readCredentials = async () => {
    for (const candidate of candidates) {
      let source;
      try {
        source = await readFile(candidate);
      } catch {
        continue;
      }
      const credentials = parseWranglerCredentials(source);
      if (credentials.token) {
        return { ...credentials, configPath: candidate };
      }
    }
    return null;
  };

  let credentials = await readCredentials();
  if (!credentials) {
    // No stored session at all. Refreshing cannot conjure one, so fall through
    // to guided setup rather than paying for a Wrangler invocation.
    return { token: "", source: TOKEN_SOURCE_NONE };
  }

  if (!isWranglerTokenUsable(credentials, now) && typeof refreshSession === "function") {
    // Invoking Wrangler is what rewrites the token on disk. Best effort: if it
    // fails we still try the stale token and let Cloudflare's 401 explain why.
    await Promise.resolve(refreshSession()).catch(() => {});
    credentials = (await readCredentials()) || credentials;
  }

  return {
    token: credentials.token,
    source: TOKEN_SOURCE_WRANGLER,
    configPath: credentials.configPath
  };
}

function cloudflareErrorMessage(payload, fallback) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const message = errors
    .map((entry) => String(entry?.message || "").trim())
    .filter(Boolean)
    .join("; ");
  return message || fallback;
}

/** Normalize one domain record down to the fields Pagecast actually stores. */
export function normalizeDomainRecord(record) {
  const name = String(record?.name || "").trim().toLowerCase();
  if (!name) return null;
  const rawStatus = String(record?.status || "").trim().toLowerCase();
  return {
    name,
    status: KNOWN_DOMAIN_STATUSES.has(rawStatus) ? rawStatus : "pending",
    certificateAuthority: String(record?.certificate_authority || "").trim(),
    validationStatus: String(record?.validation_data?.status || "").trim(),
    verificationStatus: String(record?.verification_data?.status || "").trim(),
    // Cloudflare reports the actionable reason on whichever sub-object failed.
    error:
      String(record?.validation_data?.error_message || "").trim() ||
      String(record?.verification_data?.error_message || "").trim()
  };
}

/**
 * The Pages Domains client. `resolveToken` is injected so the composition root
 * owns credential policy and this module stays a transport.
 */
export function createCloudflareApi({
  fetchImpl = globalThis.fetch,
  resolveToken = resolveCloudflareApiToken,
  timeoutMs = CLOUDFLARE_API_TIMEOUT_MS,
  apiBase = CLOUDFLARE_API_BASE
} = {}) {
  async function request(method, pathname, body) {
    const { token, source } = await resolveToken();
    if (!token) {
      // Distinguishable by statusCode so callers can offer guided setup
      // instead of surfacing this as a hard error.
      throw appError(
        "No Cloudflare credentials available for the custom-domain API. Set CLOUDFLARE_API_TOKEN " +
          "with the Pages:Edit permission, or run `pagecast pages setup` to connect Cloudflare.",
        401
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${apiBase}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
    } catch (error) {
      throw appError(`Cloudflare API request failed: ${error?.message || error}`, 502);
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.status === 401 || response.status === 403) {
      const hint =
        source === TOKEN_SOURCE_WRANGLER
          ? "The Cloudflare session may have expired — run `pagecast pages setup` to reconnect."
          : "The API token needs the Pages:Edit permission on this account.";
      throw appError(
        `${cloudflareErrorMessage(payload, "Cloudflare rejected the credentials.")} ${hint}`,
        response.status
      );
    }
    if (!response.ok || payload?.success === false) {
      throw appError(
        cloudflareErrorMessage(payload, `Cloudflare API returned ${response.status}.`),
        response.status >= 400 ? response.status : 502
      );
    }
    return payload?.result ?? null;
  }

  function domainsPath(accountId, projectName) {
    return `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(
      projectName
    )}/domains`;
  }

  return {
    async listPagesDomains({ accountId, projectName }) {
      const result = await request("GET", domainsPath(accountId, projectName));
      return (Array.isArray(result) ? result : []).map(normalizeDomainRecord).filter(Boolean);
    },

    async addPagesDomain({ accountId, projectName, domain }) {
      const name = normalizeCustomDomainName(domain);
      const result = await request("POST", domainsPath(accountId, projectName), { name });
      return normalizeDomainRecord(result) || { name, status: "pending" };
    },

    async deletePagesDomain({ accountId, projectName, domain }) {
      const name = normalizeCustomDomainName(domain);
      await request(
        "DELETE",
        `${domainsPath(accountId, projectName)}/${encodeURIComponent(name)}`
      );
      return { name };
    }
  };
}
