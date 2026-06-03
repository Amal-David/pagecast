# HTML Reporter — agent plugin

Lets your coding agent (Claude Code, Codex, or any Agent-Skills-compatible tool)
offer to publish freshly created HTML reports to a **durable public URL on your
own Cloudflare Pages account**.

How it works: a passive `PostToolUse` hook notices when an `.html`/`.htm` report
is written and hints the agent. The `publish-report` skill tells the agent to ask
*"Should I publish this with the reporter?"* and, on yes, run the headless CLI:

```sh
npx pagecast publish "/absolute/path/report.html" --json
# → {"ok":true,"url":"https://<project>.pages.dev/p/<token>/", ...}
```

The first publish auto-creates the Pages project; the one-time setup is a single
**Connect Cloudflare** click in `npx pagecast` (no account ID needed).

## Install — Claude Code

From this repo root (it ships a marketplace manifest):

```sh
/plugin marketplace add /Users/amal/experiments/html-reporter
/plugin install pagecast@pagecast
```

This wires up both the `publish-report` skill and the report-detection hook.

## Install — Codex (or any Agent-Skills tool)

Copy the portable skill into your skills directory:

```sh
mkdir -p ~/.codex/skills/publish-report
cp plugin/skills/publish-report/SKILL.md ~/.codex/skills/publish-report/SKILL.md
```

The same `SKILL.md` is the Agent-Skills open-standard format, so it works in
Codex, Cursor, Gemini CLI, and other compatible agents. The detection hook is
Claude-Code-specific; in other agents the skill still triggers on report
creation or when you ask to publish.

## Requirements

- Node.js >= 20 and `npx` available (Wrangler is fetched via `npx` on first use).
- A Cloudflare account (free tier is fine). Run `npx pagecast` once
  and click **Connect Cloudflare** to authorize scoped Pages access.
