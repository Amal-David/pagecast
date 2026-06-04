# Pagecast — agent plugin

Lets your coding agent (Claude Code, Codex, or any Agent-Skills-compatible tool)
offer to publish a freshly created **HTML or Markdown** report, plan, or doc to a
**durable public URL on your own free Cloudflare account**.

How it works: a passive `PostToolUse` hook notices when an HTML/Markdown file is
written and hints the agent. The `publish-report` skill tells the agent to offer
(once, only for finished/shareable artifacts) *"Want me to publish this with
Pagecast?"* and, on an explicit **yes**, run the headless CLI:

```sh
npx pagecast publish "/absolute/path/file.md" --json
# → {"ok":true,"url":"https://pagecast.pages.dev/p/<token>/", ...}
```

## Setup (one time)

### 1. Install the plugin

**Claude Code** — add the marketplace from the public repo, then install:

```sh
/plugin marketplace add Amal-David/pagecast
/plugin install pagecast@pagecast
```

This wires up both the `publish-report` skill and the report-detection hook.

**Codex** (or any Agent-Skills tool) — copy the portable skill:

```sh
mkdir -p ~/.codex/skills/publish-report
# from a clone of the repo:
cp plugin/skills/publish-report/SKILL.md ~/.codex/skills/publish-report/SKILL.md
```

The same `SKILL.md` is the Agent-Skills open-standard format, so it also works in
Cursor, Gemini CLI, and other compatible agents. The detection hook is
Claude-Code-specific; elsewhere the skill still triggers when a report is created
or when you ask to publish.

### 2. Connect Cloudflare (one click, free)

```sh
npx pagecast
```

Click **Connect Cloudflare** in the panel (a one-click scoped login — no account
ID, a free Cloudflare account is fine). Or sign in directly:

```sh
npx wrangler login --scopes account:read --scopes user:read --scopes pages:write
```

That's the whole setup. **After this, publishing is headless** — when your agent
makes a report and you say "yes", it publishes with no further prompts.

## What to expect

Once installed and connected: when your agent writes a report, plan, dashboard, or
other shareable HTML/Markdown, it offers *"Want me to publish this with Pagecast?"*
Say **yes** and you get back a public `pagecast.pages.dev` link you own. Say no and
it drops it — it won't nag. You can rename, re-sync, or revoke any link from
`npx pagecast`.

## Requirements

- Node.js >= 20 and `npx` (Wrangler is fetched via `npx` on first use).
- A free Cloudflare account.
