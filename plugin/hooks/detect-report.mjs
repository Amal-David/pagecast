#!/usr/bin/env node
// Passive PostToolUse hook: when a Write/Edit/MultiEdit creates or updates an
// .html/.htm file, inject a non-blocking hint so the agent can offer to publish
// it with pagecast. This hook NEVER blocks and NEVER publishes anything —
// it only adds context. Any error exits 0 silently so it can't disrupt the agent.

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function reportPathFrom(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const candidate = toolInput.file_path || toolInput.path || toolInput.filePath;
  if (typeof candidate !== "string") {
    return null;
  }
  const lower = candidate.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) {
    return null;
  }
  // Skip obvious non-report html (node_modules, hidden files).
  if (candidate.includes("/node_modules/") || candidate.split("/").pop().startsWith(".")) {
    return null;
  }
  return candidate;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.exit(0);
    }
    const event = JSON.parse(raw);
    const filePath = reportPathFrom(event.tool_input);
    if (!filePath) {
      process.exit(0);
    }

    const additionalContext =
      `An HTML report file was just written at "${filePath}". ` +
      `If it is a report worth sharing, ask the user "Should I publish this with the reporter?" ` +
      `and on yes run \`npx pagecast publish "${filePath}" --json\` to get a durable public URL ` +
      `on their own Cloudflare account. Do not publish without explicit confirmation.`;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext
        }
      })
    );
    process.exit(0);
  } catch {
    // Never disrupt the agent loop.
    process.exit(0);
  }
}

main();
