import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const PORTLESS_LOCAL_HOST = "pagecast.localhost";
export const PORTLESS_LOCAL_URL = `http://${PORTLESS_LOCAL_HOST}`;
export const PORTLESS_LOOPBACK_IP = "127.77.77.77";
export const PAGECAST_SYSTEM_SUPPORT_DIR = "/Library/Application Support/Pagecast";
export const PF_ANCHOR_NAME = "com.pagecast.localhost";
export const PF_RULES_PATH = path.posix.join(PAGECAST_SYSTEM_SUPPORT_DIR, "pagecast-localhost.pf.conf");
export const PF_LAUNCH_DAEMON_LABEL = "com.pagecast.localhost-redirect";
export const PF_LAUNCH_DAEMON_PATH = `/Library/LaunchDaemons/${PF_LAUNCH_DAEMON_LABEL}.plist`;
export const HOSTS_BEGIN = "# BEGIN PAGECAST LOCAL URL";
export const HOSTS_END = "# END PAGECAST LOCAL URL";

function assertPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid local port: ${port}`);
  }
  return value;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildPfRules({ targetPort }) {
  const port = assertPort(targetPort);
  return [
    `rdr pass on lo0 inet proto tcp from any to ${PORTLESS_LOOPBACK_IP} port 80 -> 127.0.0.1 port ${port}`,
    ""
  ].join("\n");
}

export function parsePfRulesTargetPort(rules) {
  const loopbackIp = PORTLESS_LOOPBACK_IP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(rules).match(
    new RegExp(`to\\s+${loopbackIp}\\s+port\\s+80\\s+->\\s+127\\.0\\.0\\.1\\s+port\\s+(\\d+)`)
  );
  return match ? assertPort(match[1]) : null;
}

export function pfRulesTargetPortMatches(rules, targetPort) {
  try {
    return parsePfRulesTargetPort(rules) === assertPort(targetPort);
  } catch {
    return false;
  }
}

export function buildPfLaunchDaemonPlist({
  label = PF_LAUNCH_DAEMON_LABEL,
  rulesPath = PF_RULES_PATH,
  anchorName = PF_ANCHOR_NAME,
  loopbackIp = PORTLESS_LOOPBACK_IP
} = {}) {
  const command = [
    `/sbin/ifconfig lo0 alias ${shellQuote(loopbackIp)} up >/dev/null 2>&1 || true`,
    `/sbin/pfctl -a ${shellQuote(anchorName)} -f ${shellQuote(rulesPath)}`,
    "/sbin/pfctl -E >/dev/null 2>&1 || true"
  ].join("; ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/sh</string>",
    "    <string>-c</string>",
    `    <string>${xmlEscape(command)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

export function buildLocalUrlInstallScript({
  targetPort,
  supportDir = PAGECAST_SYSTEM_SUPPORT_DIR,
  rulesPath = PF_RULES_PATH,
  daemonPath = PF_LAUNCH_DAEMON_PATH
} = {}) {
  const rules = buildPfRules({ targetPort });
  const plist = buildPfLaunchDaemonPlist({ rulesPath });
  return [
    "set -eu",
    `support_dir=${shellQuote(supportDir)}`,
    `rules_path=${shellQuote(rulesPath)}`,
    `daemon_path=${shellQuote(daemonPath)}`,
    'hosts_tmp="$(/usr/bin/mktemp)"',
    `/usr/bin/awk '/${HOSTS_BEGIN.replace(/[#]/g, "\\#")}/{skip=1; next} /${HOSTS_END.replace(/[#]/g, "\\#")}/{skip=0; next} !skip{print}' /etc/hosts > "$hosts_tmp"`,
    '/bin/cat >> "$hosts_tmp" <<\'PAGECAST_HOSTS\'',
    HOSTS_BEGIN,
    `${PORTLESS_LOOPBACK_IP} ${PORTLESS_LOCAL_HOST}`,
    HOSTS_END,
    "PAGECAST_HOSTS",
    '/bin/cat "$hosts_tmp" > /etc/hosts',
    '/bin/rm -f "$hosts_tmp"',
    '/usr/bin/install -d -m 755 "$support_dir"',
    '/bin/cat > "$rules_path" <<\'PAGECAST_PF_RULES\'',
    rules.trimEnd(),
    "PAGECAST_PF_RULES",
    '/bin/cat > "$daemon_path" <<\'PAGECAST_PLIST\'',
    plist.trimEnd(),
    "PAGECAST_PLIST",
    '/usr/sbin/chown root:wheel "$rules_path" "$daemon_path"',
    '/bin/chmod 644 "$rules_path" "$daemon_path"',
    `/sbin/ifconfig lo0 alias ${shellQuote(PORTLESS_LOOPBACK_IP)} up >/dev/null 2>&1 || true`,
    `/sbin/pfctl -a ${shellQuote(PF_ANCHOR_NAME)} -f "$rules_path"`,
    "/sbin/pfctl -E >/dev/null 2>&1 || true",
    '/bin/launchctl bootout system "$daemon_path" >/dev/null 2>&1 || true',
    '/bin/launchctl bootstrap system "$daemon_path"',
    ""
  ].join("\n");
}

export function buildLocalUrlRemoveScript({
  rulesPath = PF_RULES_PATH,
  daemonPath = PF_LAUNCH_DAEMON_PATH
} = {}) {
  return [
    "set -eu",
    `rules_path=${shellQuote(rulesPath)}`,
    `daemon_path=${shellQuote(daemonPath)}`,
    '/bin/launchctl bootout system "$daemon_path" >/dev/null 2>&1 || true',
    `/sbin/pfctl -a ${shellQuote(PF_ANCHOR_NAME)} -F all >/dev/null 2>&1 || true`,
    `/sbin/ifconfig lo0 -alias ${shellQuote(PORTLESS_LOOPBACK_IP)} >/dev/null 2>&1 || true`,
    'hosts_tmp="$(/usr/bin/mktemp)"',
    `/usr/bin/awk '/${HOSTS_BEGIN.replace(/[#]/g, "\\#")}/{skip=1; next} /${HOSTS_END.replace(/[#]/g, "\\#")}/{skip=0; next} !skip{print}' /etc/hosts > "$hosts_tmp"`,
    '/bin/cat "$hosts_tmp" > /etc/hosts',
    '/bin/rm -f "$hosts_tmp"',
    '/bin/rm -f "$rules_path" "$daemon_path"',
    ""
  ].join("\n");
}

export function backgroundLaunchAgentLabel(workingDirectory = process.cwd()) {
  const hash = createHash("sha256").update(path.resolve(workingDirectory)).digest("hex").slice(0, 12);
  return `com.pagecast.background.${hash}`;
}

export function backgroundLaunchAgentPath({
  label,
  homeDir = os.homedir()
} = {}) {
  return path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

export function buildBackgroundLaunchAgentPlist({
  label,
  nodePath,
  cliPath,
  workingDirectory,
  stdoutPath,
  stderrPath,
  pathEnv = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
} = {}) {
  if (!label || !nodePath || !cliPath || !workingDirectory) {
    throw new Error("Missing launch agent configuration.");
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(cliPath)}</string>`,
    "    <string>serve</string>",
    "    <string>--no-open</string>",
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${xmlEscape(pathEnv)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    ...(stdoutPath
      ? ["  <key>StandardOutPath</key>", `  <string>${xmlEscape(stdoutPath)}</string>`]
      : []),
    ...(stderrPath
      ? ["  <key>StandardErrorPath</key>", `  <string>${xmlEscape(stderrPath)}</string>`]
      : []),
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

export function launchGuiDomain(uid = process.getuid?.()) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("Could not determine the current macOS user id for launchd.");
  }
  return `gui/${uid}`;
}
