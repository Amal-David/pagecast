#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  deployCloudflarePagesSite,
  getCloudflarePagesStatus,
  getGoalStatus,
  listCloudflarePagesProjects,
  publishGoalProgress,
  publishReportSnapshot,
  setupCloudflareFeedback,
  setupCloudflarePages,
  startServers,
  stopGoalProgress
} from "./server.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// When invoked via npx, the package lives in the npm cache, so reports and config
// must live in the user's working directory, not next to the installed code.
const dataDir = path.join(process.cwd(), ".pagecast");
const staticDir = path.join(packageRoot, "public");

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

const VALUE_FLAGS = new Set([
  "account",
  "account-id",
  "branch",
  "label",
  "mode",
  "output",
  "project",
  "project-name",
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

async function serve() {
  const runtime = await startServers({ dataDir, staticDir });
  console.log(`Pagecast admin: ${runtime.adminUrl}`);
  console.log(`Local published-page server: ${runtime.publicUrl}`);
  console.log("Opening the admin UI in your browser. Press Ctrl-C to stop.");
  openBrowser(runtime.adminUrl);

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function publish(args) {
  const parsed = parseFlags(args);
  const json = wantsJson(parsed);
  if (parsed.positionals[0] === "site") {
    await deploySite([], { ...parsed, positionals: parsed.positionals.slice(1) });
    return;
  }
  const label = optionValue(parsed, "label");
  const reportPath = parsed.positionals[0];

  try {
    const result = await publishReportSnapshot({ path: reportPath, label, dataDir });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`Published: ${result.url}`);
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

    console.error(`Unknown pages command: ${[subcommand, ...parsed.positionals].filter(Boolean).join(" ")}\n`);
    usage();
    process.exit(1);
  } catch (error) {
    printError(error, json);
  }
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

function usage() {
  console.log(
    [
      "Usage:",
      "  pagecast [serve]                                      Start the local app and open the admin UI",
      "  pagecast publish <path> [--json]                      Publish an HTML/Markdown snapshot",
      "  pagecast publish site <dir> --project <name> [--json] Deploy a static folder to Pages",
      "  pagecast pages setup [--project <name>] [--json]      Connect and prepare Cloudflare Pages",
      "  pagecast pages status [--json]                        Show Cloudflare Pages configuration",
      "  pagecast pages projects list [--json]                 List Cloudflare Pages projects",
      "  pagecast pages deploy <dir> --project <name> [--json] Deploy a static folder to Pages",
      "  pagecast feedback setup [--account <id>] [--json]     Set up reactions + view analytics",
      "  pagecast feedback status [--json]                     Show feedback configuration",
      "  pagecast goal publish <file> [--slug goal] [--json]   Publish/update a live goal-progress page",
      "  pagecast goal status [--json]                         Show the current goal page",
      "  pagecast goal stop [--json]                           Take the goal page offline",
      "  pagecast --help                                       Show this help"
    ].join("\n")
  );
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);

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

  if (!command || command === "serve") {
    await serve();
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
