#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createConfigStore,
  deleteCloudflarePagesDeployment,
  deployCloudflarePagesSite,
  getCloudflarePagesStatus,
  getGoalStatus,
  listCloudflarePagesDeployments,
  listCloudflarePagesProjects,
  pruneCloudflarePagesDeployments,
  publishGoalProgress,
  publishReportSnapshot,
  setupCloudflareFeedback,
  setupCloudflarePages,
  startServers,
  stopGoalProgress
} from "./server.js";
import { classifyCommand, createReporter, resolveTelemetry } from "./telemetry.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = createRequire(import.meta.url)("../package.json").version;
// When invoked via npx, the package lives in the npm cache, so reports and config
// must live in the user's working directory, not next to the installed code.
const dataDir = path.join(process.cwd(), ".pagecast");
const staticDir = path.join(packageRoot, "public");
const cliPath = fileURLToPath(import.meta.url);
const backgroundPidPath = path.join(dataDir, "pagecast.pid");
const execFileAsync = promisify(execFile);
const PROCESS_LOOKUP_TIMEOUT_MS = 1000;
const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 5000;

function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Headless or no browser available — the printed URL is the fallback.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dashboardReady(url) {
  try {
    const response = await fetch(`${url}/api/status`, {
      signal: AbortSignal.timeout(750)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDashboard(url, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dashboardReady(url)) {
      return true;
    }
    await sleep(150);
  }
  return false;
}

async function readBackgroundPid() {
  const processInfo = await readBackgroundProcess();
  return processInfo.pid;
}

async function readBackgroundProcess() {
  try {
    const raw = await fs.readFile(backgroundPidPath, "utf8");
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      const pid = Number(parsed.pid);
      return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        command: Array.isArray(parsed.command) ? parsed.command.map(String) : []
      };
    }
    const pid = Number(trimmed);
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, command: [] };
  } catch {
    return { pid: null, command: [] };
  }
}

function processIsRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid) {
  if (process.platform === "win32") {
    return readWindowsProcessCommand(pid);
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: PROCESS_LOOKUP_TIMEOUT_MS
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readWindowsProcessCommand(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return "";
  }
  const powershellQuery = `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${normalizedPid}"; if ($process) { $process.CommandLine }`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", powershellQuery],
      { timeout: WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, windowsHide: true }
    );
    return stdout.trim();
  } catch {
    try {
      const { stdout } = await execFileAsync(
        "wmic",
        ["process", "where", `ProcessId=${normalizedPid}`, "get", "CommandLine", "/value"],
        { timeout: WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, windowsHide: true }
      );
      const line = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => value.startsWith("CommandLine="));
      return line ? line.slice("CommandLine=".length).trim() : "";
    } catch {
      return "";
    }
  }
}

async function backgroundProcessMatches(processInfo) {
  if (!processInfo?.pid) {
    return false;
  }
  const command = await readProcessCommand(processInfo.pid);
  if (!command) {
    return false;
  }
  const runsPagecastServe = (cli) => command.includes(cli) && /\bserve\b/.test(command);
  if (processInfo.command?.length) {
    const [nodeExecutable, recordedCliPath] = processInfo.command;
    return command.includes(nodeExecutable) && runsPagecastServe(recordedCliPath || cliPath);
  }
  return runsPagecastServe(cliPath);
}

async function removeBackgroundPid() {
  await fs.rm(backgroundPidPath, { force: true }).catch(() => {});
}

async function configuredLocalUrls() {
  const store = createConfigStore({ dataDir });
  await store.init();
  const { local } = store.get();
  return {
    adminUrl: `http://${local.hostname}:${local.adminPort}`,
    publicUrl: `http://${local.hostname}:${local.publicPort}`
  };
}

async function confirmPrompt(question) {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// First-run notice (stderr, so it never pollutes --json stdout).
function printTelemetryNotice() {
  process.stderr.write(
    [
      "Pagecast collects anonymous usage stats (which command ran, version, OS) to guide development.",
      "No file contents, paths, URLs, or account info are ever sent.",
      "Opt out anytime: `pagecast telemetry disable`, or set PAGECAST_TELEMETRY=0 / DO_NOT_TRACK=1.",
      ""
    ].join("\n")
  );
}

// Resolve telemetry settings, show the one-time notice, and return a reporter.
// Always returns a usable reporter; any failure degrades to a silent no-op so
// telemetry can never break or slow a command.
async function setupTelemetry() {
  const noop = { record: async () => false, enabled: false };
  let store;
  try {
    store = createConfigStore({ dataDir });
    await store.init();
    const cfg = store.get();
    const { enabled } = resolveTelemetry({ configEnabled: cfg.telemetry, env: process.env });
    if (!enabled) {
      return noop;
    }
    const anonId = cfg.telemetryId || (await store.ensureTelemetryId());
    if (!cfg.telemetryNotified) {
      printTelemetryNotice();
      await store.markTelemetryNotified();
    }
    return createReporter({ enabled: true, version: packageVersion, anonId, env: process.env });
  } catch {
    return noop;
  }
}

const VALUE_FLAGS = new Set([
  "account",
  "account-id",
  "branch",
  "expires",
  "host",
  "keep",
  "label",
  "mode",
  "output",
  "password",
  "port",
  "project",
  "project-name",
  "public-port",
  "slug"
]);

function parseFlags(args) {
  const flags = new Set();
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const equalsIndex = withoutPrefix.indexOf("=");
      const key = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
      if (equalsIndex >= 0) {
        options[key] = withoutPrefix.slice(equalsIndex + 1);
      } else if (VALUE_FLAGS.has(key)) {
        const next = args[i + 1];
        if (typeof next === "string" && !next.startsWith("--")) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = "";
        }
      } else {
        flags.add(key);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, options, positionals };
}

function optionValue(parsed, ...names) {
  for (const name of names) {
    if (typeof parsed.options[name] === "string" && parsed.options[name].trim()) {
      return parsed.options[name];
    }
  }
  return "";
}

function wantsJson(parsed) {
  return parsed.flags.has("json") || optionValue(parsed, "output") === "json";
}

function errorCode(statusCode) {
  if (statusCode === 400) {
    return "usage_error";
  }
  if (statusCode === 401) {
    return "auth_required";
  }
  if (statusCode === 404) {
    return "not_found";
  }
  if (statusCode === 409) {
    return "conflict";
  }
  if (statusCode >= 500) {
    return "provider_error";
  }
  return "error";
}

function printError(error, json) {
  const statusCode = error.statusCode || 500;
  const payload = {
    ok: false,
    code: errorCode(statusCode),
    error: error.message,
    statusCode
  };
  if (json) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(error.message);
  }
  process.exit(statusCode === 400 ? 2 : 1);
}

function pagesOptions(parsed) {
  return {
    projectName: optionValue(parsed, "project", "project-name"),
    accountId: optionValue(parsed, "account", "account-id"),
    branch: optionValue(parsed, "branch") || "main"
  };
}

function printDeployResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  console.log(`Deployed: ${result.url}`);
  if (result.deploymentUrl && result.deploymentUrl !== result.url) {
    console.log(`Deployment URL: ${result.deploymentUrl}`);
  }
}

function printSetupResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  const projectName = result.config?.pages?.projectName || result.cloudflare?.selectedProject?.name || "pagecast";
  const accountName = result.cloudflare?.account?.name || result.config?.pages?.accountName || "Cloudflare account";
  console.log(`Cloudflare Pages ready: ${projectName}`);
  console.log(`Account: ${accountName}`);
}

function printStatusResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  const status = result.cloudflare.loggedIn ? "connected" : "not connected";
  console.log(`Cloudflare: ${status}`);
  console.log(`Project: ${result.cloudflare.projectName}`);
  if (result.cloudflare.accountName) {
    console.log(`Account: ${result.cloudflare.accountName}`);
  }
  console.log(`URL: ${result.cloudflare.baseUrl}`);
}

function printDeploymentsResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  const deployments = result.deployments || [];
  if (deployments.length === 0) {
    console.log("No deployments found.");
    return;
  }
  for (const deployment of deployments) {
    const marker = deployment.isLive ? "● live" : "      ";
    const created = deployment.createdOn || "";
    const shortId = (deployment.shortId || deployment.id || "").padEnd(10);
    const env = (deployment.environment || "").padEnd(10);
    console.log(`${marker}  ${shortId}  ${env}  ${created}  ${deployment.url || ""}`);
  }
}

function printProjectsResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (result.projects.length === 0) {
    console.log("No Cloudflare Pages projects found.");
    return;
  }
  for (const project of result.projects) {
    const branch = project.productionBranch ? ` (${project.productionBranch})` : "";
    console.log(`${project.name}${branch}`);
  }
}

async function serve(args = []) {
  const parsed = parseFlags(args);
  const host = optionValue(parsed, "host");
  const port = optionValue(parsed, "port");
  const publicPort = optionValue(parsed, "public-port");
  const runtime = await startServers({
    dataDir,
    staticDir,
    host: host || undefined,
    adminPort: port ? Number(port) : undefined,
    publicPort: publicPort ? Number(publicPort) : undefined
  });
  console.log(`Pagecast admin: ${runtime.adminUrl}`);
  console.log(`Local published-page server: ${runtime.publicUrl}`);
  if (parsed.flags.has("no-open")) {
    console.log("Running quietly. Press Ctrl-C to stop.");
  } else {
    console.log("Opening the admin UI in your browser. Press Ctrl-C to stop.");
    openBrowser(runtime.adminUrl);
  }

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function background(args = []) {
  const [subcommand = "status"] = args;
  const urls = await configuredLocalUrls();

  if (subcommand === "start") {
    if (await dashboardReady(urls.adminUrl)) {
      console.log(`Pagecast is already running: ${urls.adminUrl}`);
      return;
    }
    const existingProcess = await readBackgroundProcess();
    if (processIsRunning(existingProcess.pid) && (await backgroundProcessMatches(existingProcess))) {
      console.log(`Pagecast background process is starting: ${urls.adminUrl}`);
      return;
    }
    await fs.mkdir(dataDir, { recursive: true });
    const child = spawn(process.execPath, [cliPath, "serve", "--no-open"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    await fs.writeFile(
      backgroundPidPath,
      `${JSON.stringify({
        pid: child.pid,
        command: [process.execPath, cliPath, "serve", "--no-open"],
        startedAt: new Date().toISOString()
      })}\n`,
      "utf8"
    );
    const ready = await waitForDashboard(urls.adminUrl);
    const refreshed = await configuredLocalUrls();
    console.log(
      ready
        ? `Pagecast is running: ${refreshed.adminUrl}`
        : `Pagecast background process started. Try ${refreshed.adminUrl} in a moment.`
    );
    return;
  }

  if (subcommand === "stop") {
    const processInfo = await readBackgroundProcess();
    if (processIsRunning(processInfo.pid) && (await backgroundProcessMatches(processInfo))) {
      process.kill(processInfo.pid, "SIGTERM");
      await sleep(250);
      console.log("Pagecast background process stopped.");
    } else {
      console.log("Pagecast background process is not running.");
    }
    await removeBackgroundPid();
    return;
  }

  if (subcommand === "status") {
    const processInfo = await readBackgroundProcess();
    const ready = await dashboardReady(urls.adminUrl);
    if (ready) {
      console.log(`Pagecast is running: ${urls.adminUrl}`);
    } else if (processIsRunning(processInfo.pid) && (await backgroundProcessMatches(processInfo))) {
      console.log(`Pagecast background process is starting: ${urls.adminUrl}`);
    } else {
      console.log(`Pagecast is stopped. Start it with: pagecast background start`);
    }
    return;
  }

  console.error(`Unknown background command: ${subcommand}\n`);
  usage();
  process.exit(1);
}

async function openLocalDashboard() {
  let urls = await configuredLocalUrls();
  if (!(await dashboardReady(urls.adminUrl))) {
    await background(["start"]);
    urls = await configuredLocalUrls();
  }
  openBrowser(urls.adminUrl);
  console.log(`Opened Pagecast: ${urls.adminUrl}`);
}

async function publish(args) {
  const parsed = parseFlags(args);
  const json = wantsJson(parsed);
  if (parsed.positionals[0] === "site") {
    await deploySite([], { ...parsed, positionals: parsed.positionals.slice(1) });
    return;
  }
  const label = optionValue(parsed, "label");
  const passwordProvided = Object.prototype.hasOwnProperty.call(parsed.options, "password");
  const password = optionValue(parsed, "password");
  const disableProtection = parsed.flags.has("no-password");
  const expires = optionValue(parsed, "expires"); // e.g. 7d, 12h, never (empty = default)
  const reportPath = parsed.positionals[0];

  if (passwordProvided && disableProtection) {
    printError({ message: "Use either --password or --no-password, not both.", statusCode: 400 }, json);
    return;
  }
  if (passwordProvided && !password) {
    printError(
      { message: "--password cannot be empty. Provide a value, or use --no-password to remove protection.", statusCode: 400 },
      json
    );
    return;
  }

  try {
    const result = await publishReportSnapshot({
      path: reportPath,
      label,
      password,
      disableProtection,
      expires,
      dataDir
    });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`Published: ${result.url}`);
      if (result.passwordProtected) {
        console.log("Password protection: on (visitors must enter the password).");
      }
      console.log(
        result.expiresAt
          ? `Expires: ${new Date(result.expiresAt).toISOString()}`
          : "Expires: never"
      );
    }
  } catch (error) {
    printError(error, json);
  }
}

async function deploySite(args, parsed = parseFlags(args)) {
  const json = wantsJson(parsed);
  const sourceDir = parsed.positionals[0];
  const { projectName, accountId, branch } = pagesOptions(parsed);

  try {
    const result = await deployCloudflarePagesSite({
      sourceDir,
      projectName,
      accountId,
      branch,
      dataDir
    });
    printDeployResult(result, json);
  } catch (error) {
    printError(error, json);
  }
}

async function pages(args) {
  const [subcommand, ...rest] = args;
  const parsed = parseFlags(rest);
  const json = wantsJson(parsed);
  const { projectName, accountId, branch } = pagesOptions(parsed);

  try {
    if (subcommand === "setup") {
      const result = await setupCloudflarePages({
        projectName,
        accountId,
        branch,
        dataDir
      });
      printSetupResult(result, json);
      return;
    }

    if (subcommand === "status") {
      const result = await getCloudflarePagesStatus({ dataDir });
      printStatusResult(result, json);
      return;
    }

    if (subcommand === "projects" && parsed.positionals[0] === "list") {
      const result = await listCloudflarePagesProjects({
        accountId,
        dataDir
      });
      printProjectsResult(result, json);
      return;
    }

    if (subcommand === "deploy") {
      await deploySite(rest);
      return;
    }

    if (subcommand === "deployments") {
      await deployments(parsed.positionals, parsed);
      return;
    }

    console.error(`Unknown pages command: ${[subcommand, ...parsed.positionals].filter(Boolean).join(" ")}\n`);
    usage();
    process.exit(1);
  } catch (error) {
    printError(error, json);
  }
}

async function deployments(positionals, parsed) {
  const [subcommand, ...rest] = positionals;
  const json = wantsJson(parsed);
  const accountId = optionValue(parsed, "account", "account-id");

  if (subcommand === "list" || !subcommand) {
    const result = await listCloudflarePagesDeployments({ accountId, dataDir });
    printDeploymentsResult(result, json);
    return;
  }

  if (subcommand === "delete") {
    const id = rest[0];
    if (!id) {
      printError({ message: "Usage: pagecast pages deployments delete <id>", statusCode: 400 }, json);
      return;
    }
    const result = await deleteCloudflarePagesDeployment({
      id,
      force: parsed.flags.has("force"),
      accountId,
      dataDir
    });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`Removed deployment ${result.id}.`);
    }
    return;
  }

  if (subcommand === "prune") {
    const keepCount = Number(optionValue(parsed, "keep"));
    if (!Number.isInteger(keepCount) || keepCount < 1) {
      printError({ message: "Usage: pagecast pages deployments prune --keep <N>", statusCode: 400 }, json);
      return;
    }
    if (!parsed.flags.has("yes")) {
      if (json || !process.stdin.isTTY) {
        printError(
          { message: "Refusing to prune without confirmation. Re-run with --yes.", statusCode: 400 },
          json
        );
        return;
      }
      const ok = await confirmPrompt(
        `Delete all but the ${keepCount} most recent deployments? This can't be undone. [y/N] `
      );
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
    }
    const result = await pruneCloudflarePagesDeployments({ keep: keepCount, accountId, dataDir });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`Removed ${result.pruned} deployment(s); kept the ${result.kept} most recent.`);
      if (result.failed.length > 0) {
        console.log(`${result.failed.length} could not be deleted.`);
      }
    }
    return;
  }

  console.error(`Unknown deployments command: ${subcommand || ""}\n`);
  usage();
  process.exit(1);
}

async function feedback(args) {
  const [subcommand, ...rest] = args;
  const parsed = parseFlags(rest);
  const json = wantsJson(parsed);
  const accountId = optionValue(parsed, "account", "account-id");

  try {
    if (subcommand === "setup") {
      const result = await setupCloudflareFeedback({ accountId, dataDir });
      if (json) {
        console.log(JSON.stringify({ ok: true, ...result }));
      } else if (result.feedback?.url) {
        console.log(`Feedback ready: ${result.feedback.url}`);
        console.log("Reactions + view analytics now attach to pages you publish.");
      } else {
        console.log("Feedback setup did not complete.");
      }
      return;
    }

    if (subcommand === "status") {
      const status = await getCloudflarePagesStatus({ dataDir });
      const fb = status.config?.feedback;
      if (json) {
        console.log(JSON.stringify({ ok: true, feedback: fb || null }));
      } else if (fb?.url) {
        console.log(`Feedback: enabled (${fb.url})`);
      } else {
        console.log("Feedback: not set up. Run `pagecast feedback setup`.");
      }
      return;
    }

    console.error(`Unknown feedback command: ${subcommand || ""}\n`);
    usage();
    process.exit(1);
  } catch (error) {
    printError(error, json);
  }
}

async function goal(args) {
  const [subcommand, ...rest] = args;
  const parsed = parseFlags(rest);
  const json = wantsJson(parsed);

  try {
    if (subcommand === "publish") {
      const file = parsed.positionals[0];
      const slug = optionValue(parsed, "slug") || "goal";
      const result = await publishGoalProgress({ file, slug, dataDir });
      if (json) {
        console.log(JSON.stringify({ ok: true, ...result }));
      } else {
        console.log(`${result.started ? "Goal page live" : "Goal page updated"}: ${result.url}`);
        if (result.recreated) {
          console.log("(The previous link was gone, so a new URL was created.)");
        }
      }
      return;
    }

    if (subcommand === "status") {
      const { goal: g } = await getGoalStatus({ dataDir });
      if (json) {
        console.log(JSON.stringify({ ok: true, goal: g || null }));
      } else if (g?.url) {
        console.log(`Goal page: ${g.url}`);
        console.log(`Source: ${g.file || "(unknown)"}`);
      } else {
        console.log("No goal page. Run `pagecast goal publish <file>`.");
      }
      return;
    }

    if (subcommand === "stop") {
      const result = await stopGoalProgress({ dataDir });
      if (json) {
        console.log(JSON.stringify({ ok: true, ...result }));
      } else {
        console.log(result.stopped ? "Goal page taken offline." : "No goal page to stop.");
      }
      return;
    }

    console.error(`Unknown goal command: ${subcommand || ""}\n`);
    usage();
    process.exit(1);
  } catch (error) {
    printError(error, json);
  }
}

async function telemetry(args) {
  const [subcommand, ...rest] = args;
  const parsed = parseFlags(rest);
  const json = wantsJson(parsed);
  const store = createConfigStore({ dataDir });
  await store.init();

  if (!subcommand || subcommand === "status") {
    const cfg = store.get();
    const { enabled, reason } = resolveTelemetry({ configEnabled: cfg.telemetry, env: process.env });
    if (json) {
      console.log(
        JSON.stringify({ ok: true, telemetry: { enabled, reason, configEnabled: cfg.telemetry } })
      );
    } else {
      console.log(`Telemetry: ${enabled ? "enabled" : "disabled"} (${reason})`);
      console.log(
        "Toggle with `pagecast telemetry enable|disable`, or set PAGECAST_TELEMETRY=0 / DO_NOT_TRACK=1."
      );
    }
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const next = subcommand === "enable";
    await store.setTelemetry(next);
    // An explicit choice counts as acknowledging the notice.
    await store.markTelemetryNotified();
    // Report the EFFECTIVE state, not just the saved preference: env settings
    // (DO_NOT_TRACK / PAGECAST_TELEMETRY / CI) can still override it, so a bare
    // "enabled" could contradict what `telemetry status` reports next.
    const { enabled, reason } = resolveTelemetry({ configEnabled: next, env: process.env });
    if (json) {
      console.log(JSON.stringify({ ok: true, telemetry: { configEnabled: next, enabled, reason } }));
    } else {
      console.log(`Telemetry preference saved: ${next ? "enabled" : "disabled"}.`);
      if (enabled !== next) {
        console.log(`Effective state: ${enabled ? "enabled" : "disabled"} (${reason} overrides the saved preference).`);
      }
    }
    return;
  }

  console.error(`Unknown telemetry command: ${subcommand}\n`);
  usage();
  process.exit(1);
}

function usage() {
  console.log(
    [
      "Usage:",
      "  pagecast [serve] [--no-open] [--host <host>] [--port 4173] [--public-port 4174]",
      "                                                        Start the local app and open the admin UI",
      "  pagecast open                                        Open the local app, starting it in the background if needed",
      "  pagecast background start|stop|status                Keep the local app running without a terminal tab",
      "  pagecast publish <path> [--password <pw>|--no-password] [--expires <7d|12h|never>] [--json]",
      "                                                        Publish an HTML/Markdown snapshot",
      "  pagecast publish site <dir> --project <name> [--json] Deploy a static folder to Pages",
      "  pagecast pages setup [--project <name>] [--json]      Connect and prepare Cloudflare Pages",
      "  pagecast pages status [--json]                        Show Cloudflare Pages configuration",
      "  pagecast pages projects list [--json]                 List Cloudflare Pages projects",
      "  pagecast pages deploy <dir> --project <name> [--json] Deploy a static folder to Pages",
      "  pagecast pages deployments list [--json]              List Cloudflare Pages deployment snapshots",
      "  pagecast pages deployments delete <id> [--force] [--json]  Remove one deployment snapshot",
      "  pagecast pages deployments prune --keep <N> [--yes] [--json]  Keep the N newest, remove the rest",
      "  pagecast feedback setup [--account <id>] [--json]     Set up reactions + view analytics",
      "  pagecast feedback status [--json]                     Show feedback configuration",
      "  pagecast goal publish <file> [--slug goal] [--json]   Publish/update a live goal-progress page",
      "  pagecast goal status [--json]                         Show the current goal page",
      "  pagecast goal stop [--json]                           Take the goal page offline",
      "  pagecast telemetry status [--json]                    Show anonymous-usage-telemetry state",
      "  pagecast telemetry enable|disable                     Turn anonymous usage telemetry on/off",
      "  pagecast --help                                       Show this help"
    ].join("\n")
  );
}

async function run() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  // The telemetry command manages its own state; don't emit an event for it
  // (avoids phoning home on the very command used to opt out).
  if (command === "telemetry") {
    await telemetry(rest);
    return;
  }

  // Anonymous, opt-out usage event for every other command. Fire-and-forget:
  // never awaited, never throws, bounded by the reporter's own timeout.
  const reporter = await setupTelemetry();
  reporter.record(classifyCommand(argv)).catch(() => {});

  if (command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }

  if (command === "publish") {
    await publish(rest);
    return;
  }

  if (command === "pages") {
    await pages(rest);
    return;
  }

  if (command === "feedback") {
    await feedback(rest);
    return;
  }

  if (command === "goal") {
    await goal(rest);
    return;
  }

  if (command === "background") {
    await background(rest);
    return;
  }

  if (command === "open") {
    await openLocalDashboard();
    return;
  }

  if (!command || command === "serve") {
    await serve(rest);
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
