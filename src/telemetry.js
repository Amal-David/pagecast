// Pagecast usage telemetry.
//
// Anonymous, consent-gated usage telemetry for the CLI: which command was run, the
// pagecast/Node version, and coarse OS/arch. It mirrors the privacy posture of
// the feedback feature — aggregate, anonymous, no PII, no file paths, no
// published URLs, no Cloudflare tokens/account IDs.
//
// Everything here is dependency-free (Node built-ins + globalThis.fetch) and the
// pure helpers are exported so they can be unit-tested without a network. The
// reporter is fire-and-forget: it never throws, never blocks command output, and
// is a no-op when telemetry is disabled.

import os from "node:os";
import process from "node:process";

// The maintainer's own ingestion endpoint — a Pages Function on the pagecast
// site (see the pagecast-landing repo, functions/api/v1/event.js). Overridable
// via PAGECAST_TELEMETRY_URL so tests and self-hosters can point elsewhere.
export const DEFAULT_TELEMETRY_ENDPOINT =
  "https://pagecasthq.pages.dev/api/v1/event";
// Short by design: telemetry must never meaningfully delay process exit, so an
// unreachable endpoint is abandoned quickly.
export const DEFAULT_TELEMETRY_TIMEOUT_MS = 1000;

// Only these top-level commands and their fixed subcommands are ever reported.
// Anything outside the allowlists is dropped, so positional user data (e.g. a
// `publish <path>` argument) can never leak into the payload.
const COMMAND_ALLOWLIST = new Set([
  "serve",
  "publish",
  "pages",
  "feedback",
  "goal",
  "background",
  "local-url",
  "setup-local-url",
  "open",
  "telemetry",
  "help",
  "version"
]);
const SUBCOMMAND_ALLOWLIST = {
  pages: new Set(["setup", "status", "projects", "deploy", "deployments"]),
  feedback: new Set(["setup", "status"]),
  goal: new Set(["publish", "status", "stop"]),
  background: new Set(["start", "stop", "status", "service"]),
  "local-url": new Set(["install", "remove", "status", "setup", "uninstall"]),
  telemetry: new Set(["status", "enable", "disable"])
};

function isTruthyEnv(value) {
  if (value === undefined || value === null) {
    return false;
  }
  const v = String(value).trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

// Resolve whether telemetry should actually run, plus the deciding reason.
// Precedence (highest first): DO_NOT_TRACK, explicit PAGECAST_TELEMETRY, CI,
// then the saved choice. Fresh interactive installs are enabled by default.
export function resolveTelemetry({ configEnabled = null, env = process.env } = {}) {
  if (isTruthyEnv(env.DO_NOT_TRACK)) {
    return { enabled: false, reason: "do-not-track" };
  }
  const flag = env.PAGECAST_TELEMETRY;
  if (flag !== undefined && String(flag).trim() !== "") {
    return isTruthyEnv(flag)
      ? { enabled: true, reason: "env" }
      : { enabled: false, reason: "env" };
  }
  if (isTruthyEnv(env.CI)) {
    return { enabled: false, reason: "ci" };
  }
  if (configEnabled === false) {
    return { enabled: false, reason: "config" };
  }
  if (configEnabled === true) {
    return { enabled: true, reason: "config" };
  }
  return { enabled: true, reason: "default" };
}

// Map raw argv (process.argv.slice(2)) to a safe { command, subcommand } pair
// using the allowlists above. Unknown commands collapse to "unknown"; unknown or
// missing subcommands are omitted. Never returns free-form user input.
export function classifyCommand(argv = []) {
  const first = String(argv[0] || "").trim();
  if (first === "" || first === "serve") {
    return { command: "serve" };
  }
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help" };
  }
  if (first === "--version" || first === "-v" || first === "version") {
    return { command: "version" };
  }
  if (!COMMAND_ALLOWLIST.has(first)) {
    return { command: "unknown" };
  }
  const allowedSubs = SUBCOMMAND_ALLOWLIST[first];
  const second = String(argv[1] || "").trim();
  if (allowedSubs && allowedSubs.has(second)) {
    return { command: first, subcommand: second };
  }
  return { command: first };
}

// Build the flat, anonymous event payload. Contains ONLY the fields below — no
// paths, URLs, tokens, account IDs, or other user data.
export function buildPayload({
  command,
  subcommand,
  outcome = "started",
  version,
  anonId,
  platform = os.platform(),
  arch = os.arch(),
  nodeVersion = process.version
} = {}) {
  const payload = {
    event: "command",
    command: String(command || "unknown"),
    outcome: String(outcome || "started"),
    version: String(version || "0.0.0"),
    os: String(platform || ""),
    arch: String(arch || ""),
    node: String(nodeVersion || ""),
    anonId: String(anonId || "")
  };
  if (subcommand) {
    payload.subcommand = String(subcommand);
  }
  return payload;
}

// Create a reporter bound to a resolved enabled-state and identity. `record()` is
// fire-and-forget: it always resolves (true on a sent event, false otherwise) and
// never throws. When disabled it performs no network call at all.
export function createReporter({
  enabled = false,
  endpoint = DEFAULT_TELEMETRY_ENDPOINT,
  version,
  anonId,
  timeoutMs = DEFAULT_TELEMETRY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  env = process.env
} = {}) {
  const resolvedEndpoint =
    (env && String(env.PAGECAST_TELEMETRY_URL || "").trim()) || endpoint;

  async function record({ command, subcommand, outcome } = {}) {
    if (!enabled || typeof fetchImpl !== "function") {
      return false;
    }
    const payload = buildPayload({ command, subcommand, outcome, version, anonId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    try {
      const response = await fetchImpl(resolvedEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      // A resolved fetch still means failure for 4xx/5xx (e.g. the worker
      // rejecting a bad payload); only 2xx counts as delivered.
      return Boolean(response && response.ok);
    } catch {
      // Swallow everything — telemetry must never surface an error to the user.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return { record, enabled, endpoint: resolvedEndpoint };
}
