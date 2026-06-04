#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startServers, publishReportSnapshot } from "./server.js";

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

function parseFlags(args) {
  const flags = new Set();
  const positionals = [];
  let label;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--label") {
      label = args[i + 1];
      i += 1;
    } else if (arg === "--mode") {
      // Only Cloudflare snapshots are headless-publishable today; accept and ignore.
      i += 1;
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals, label };
}

async function serve() {
  const runtime = await startServers({ dataDir, staticDir });
  console.log(`Pagecast admin: ${runtime.adminUrl}`);
  console.log(`Local report server: ${runtime.publicUrl}`);
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
  const { flags, positionals, label } = parseFlags(args);
  const json = flags.has("--json");
  const reportPath = positionals[0];

  try {
    const result = await publishReportSnapshot({ path: reportPath, label, dataDir });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`Published: ${result.url}`);
    }
  } catch (error) {
    const payload = {
      ok: false,
      error: error.message,
      statusCode: error.statusCode || 500
    };
    if (json) {
      console.log(JSON.stringify(payload));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

function usage() {
  console.log(
    [
      "Usage:",
      "  pagecast [serve]                 Start the local app and open the admin UI",
      "  pagecast publish <path> [--json] Publish an HTML report snapshot to Cloudflare Pages",
      "  pagecast --help                  Show this help"
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
