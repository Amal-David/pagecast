// Pagecast telemetry Worker.
//
// One small Cloudflare Worker, deployed once to the maintainer's own account,
// that ingests anonymous CLI usage events (POST /api/v1/event) and writes them to
// a Workers Analytics Engine dataset. The pagecast CLI POSTs here when telemetry
// is enabled (see src/telemetry.js); users opt out with `pagecast telemetry
// disable`, PAGECAST_TELEMETRY=0, or DO_NOT_TRACK=1.
//
// Privacy: only the coarse, anonymous fields below are stored — the command run,
// pagecast/Node version, and OS/arch, plus a random opaque install id. No file
// contents, no file paths, no published URLs, no Cloudflare tokens/account IDs,
// no IP addresses. The Worker re-validates everything against fixed allowlists so
// it can never store arbitrary attacker-controlled strings or unbounded
// cardinality, regardless of what a client sends.
//
// The pure helpers are exported so they can be unit-tested under Node without a
// Workers runtime (see test/telemetry.test.js).

// Mirror of the CLI allowlists; the Worker trusts nothing from the client.
export const COMMAND_ALLOWLIST = [
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
  "version",
  "unknown"
];
const SUBCOMMAND_ALLOWLIST = {
  pages: ["setup", "status", "projects", "deploy", "deployments"],
  feedback: ["setup", "status"],
  goal: ["publish", "status", "stop"],
  background: ["start", "stop", "status", "service"],
  "local-url": ["install", "remove", "status", "setup", "uninstall"],
  telemetry: ["status", "enable", "disable"]
};
const OUTCOME_ALLOWLIST = ["started", "success", "error"];
// Node's os.platform() / os.arch() value sets — finite, so allowlist them to keep
// the dataset low-cardinality (a public endpoint must not let callers store
// arbitrary blobs).
const OS_ALLOWLIST = [
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32"
];
const ARCH_ALLOWLIST = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64"
];

export function cleanCommand(value) {
  const v = String(value || "").trim().toLowerCase();
  return COMMAND_ALLOWLIST.includes(v) ? v : null;
}

export function cleanSubcommand(command, value) {
  const allowed = SUBCOMMAND_ALLOWLIST[command];
  const v = String(value || "").trim().toLowerCase();
  return allowed && allowed.includes(v) ? v : "";
}

export function cleanOutcome(value) {
  const v = String(value || "").trim().toLowerCase();
  return OUTCOME_ALLOWLIST.includes(v) ? v : "started";
}

// Field-specific validators for the coarse platform fields. Anything that doesn't
// match the expected shape is dropped to "" so a caller can't poison the dataset
// with arbitrary high-cardinality strings.
export function cleanEnum(value, allowlist) {
  const v = String(value || "").trim().toLowerCase();
  return allowlist.includes(v) ? v : "";
}

// Semver-ish (pagecast version): "1.2.3" with an optional prerelease/build tail.
export function cleanVersion(value) {
  const v = String(value || "").trim();
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(v) ? v : "";
}

// Node version: "v22.22.3" (the leading "v" is optional).
export function cleanNodeVersion(value) {
  const v = String(value || "").trim();
  return /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : "";
}

// The anonymous install id is a 32-char hex string (16 random bytes). Anything
// else is dropped to empty.
export function cleanAnonId(value) {
  const v = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(v) ? v : "";
}

// Turn a raw client payload into an Analytics Engine data point, or null if the
// payload isn't an object or the command is not recognized (event is rejected).
export function buildDataPoint(payload = {}) {
  // JSON `null`/`123`/`"x"` parse fine but aren't objects; guard before access.
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const command = cleanCommand(payload.command);
  if (!command) {
    return null;
  }
  const subcommand = cleanSubcommand(command, payload.subcommand);
  const outcome = cleanOutcome(payload.outcome);
  const version = cleanVersion(payload.version);
  const osName = cleanEnum(payload.os, OS_ALLOWLIST);
  const arch = cleanEnum(payload.arch, ARCH_ALLOWLIST);
  const node = cleanNodeVersion(payload.node);
  const anonId = cleanAnonId(payload.anonId);
  return {
    // indexes: max 1, used for sampling/grouping. Keep it the command name.
    indexes: [command],
    blobs: [command, subcommand, outcome, version, osName, arch, node, anonId],
    doubles: [1]
  };
}

// --- Worker runtime (not exercised by the Node tests) ----------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/event") {
      const body = await request.json().catch(() => ({}));
      const dataPoint = buildDataPoint(body);
      if (!dataPoint) {
        return json({ ok: false, error: "bad event" }, 400);
      }
      // Best-effort write; never fail the request if the binding is absent.
      try {
        env.PAGECAST_TELEMETRY?.writeDataPoint(dataPoint);
      } catch {
        // Swallow — telemetry ingestion must not error noisily.
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
};
