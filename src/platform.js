// Last Wrangler release compatible with Pagecast's Node 20.19 floor. Wrangler
// 4.87+ requires Node 22, so keep this exact pin aligned with package.json, CI,
// and the container toolchain proof.
export const PINNED_WRANGLER_VERSION = "4.86.0";
export const WRANGLER_VERSION_OVERRIDE_ENV =
  "PAGECAST_WRANGLER_VERSION_OVERRIDE";
export const WRANGLER_GLOBAL_ENV = "PAGECAST_USE_GLOBAL_WRANGLER";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/**
 * Select the native command interpreter for a user-authored build command.
 * The command remains one argument so Node, rather than Pagecast, owns the
 * platform-specific argv quoting.
 */
export function selectBuildShell(
  command,
  { platform = process.platform, env = process.env } = {}
) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("A non-empty build command is required.");
  }

  if (platform === "win32") {
    const comSpec = String(env?.ComSpec || env?.COMSPEC || "cmd.exe").trim();
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }

  return { command: "sh", args: ["-lc", command] };
}

/**
 * Production always uses the source-controlled pin. Tests and local Wrangler
 * compatibility work may opt into another exact version explicitly.
 */
export function resolveWranglerVersion({ env = process.env } = {}) {
  const override = String(env?.[WRANGLER_VERSION_OVERRIDE_ENV] || "").trim();
  const version = override || PINNED_WRANGLER_VERSION;
  if (!EXACT_VERSION.test(version)) {
    throw new TypeError(
      `${WRANGLER_VERSION_OVERRIDE_ENV} must be an exact semantic version.`
    );
  }
  return version;
}

export function wranglerPackageSpecifier(options = {}) {
  return `wrangler@${resolveWranglerVersion(options)}`;
}

export function createWranglerNpxArgs(args = [], options = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError("Wrangler arguments must be an array.");
  }
  return ["--yes", wranglerPackageSpecifier(options), ...args.map(String)];
}

/**
 * Native installs use npx with the exact source-controlled version. The Docker
 * image sets PAGECAST_USE_GLOBAL_WRANGLER=1 after baking that same version, so
 * runtime publishes work without contacting the npm registry again.
 */
export function createWranglerInvocation(args = [], { env = process.env } = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError("Wrangler arguments must be an array.");
  }
  if (String(env?.[WRANGLER_GLOBAL_ENV] || "").trim() === "1") {
    return { command: "wrangler", args: args.map(String) };
  }
  return { command: "npx", args: createWranglerNpxArgs(args, { env }) };
}
