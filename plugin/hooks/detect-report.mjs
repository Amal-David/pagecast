#!/usr/bin/env node
// Passive PostToolUse hook: when a Write/Edit/MultiEdit creates or updates an
// HTML or Markdown file (a report, plan, doc, or dashboard), inject a
// non-blocking hint so the agent can offer to publish it with Pagecast. This
// hook NEVER blocks and NEVER publishes anything — it only adds context, and the
// skill decides whether the file is actually worth offering. Any error exits 0
// silently so it can't disrupt the agent.

// Obvious non-artifacts the agent should not be nudged to publish. The skill
// applies the real judgment; this just keeps the common noise down.
const SKIP_BASENAMES = new Set([
  "readme.md",
  "readme.markdown",
  "changelog.md",
  "contributing.md",
  "license.md",
  "code_of_conduct.md",
  "security.md",
  "agents.md",
  "claude.md",
  "todo.md",
  "tasks.md",
  "notes.md"
]);

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
  const isPublishable =
    lower.endsWith(".html") ||
    lower.endsWith(".htm") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown");
  if (!isPublishable) {
    return null;
  }

  const base = candidate.split("/").pop() || "";
  // Skip obvious non-artifacts: build/dependency dirs, hidden files, and common
  // repo-meta files that nobody wants to publish.
  if (
    candidate.includes("/node_modules/") ||
    candidate.includes("/dist/") ||
    candidate.includes("/.git/") ||
    base.startsWith(".") ||
    SKIP_BASENAMES.has(base.toLowerCase())
  ) {
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
      `A shareable HTML/Markdown file was just written at "${filePath}". ` +
      `Default action: when you finish this turn, proactively offer ONCE to publish it — ` +
      `ask the user exactly "Want me to publish this with Pagecast? It'll create a shareable public link." ` +
      `Offer unless the file is clearly internal/scratch (a draft note, a config/source file, or repo meta ` +
      `like README/CHANGELOG/TODO — those were already filtered, so lean toward offering). ` +
      `Do not stay silent just because you are unsure. ` +
      `Only on an explicit yes, run \`npx pagecast publish "${filePath}" --json\` and return the URL. ` +
      `Never publish without an explicit yes, and ask at most once for this file.`;

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
