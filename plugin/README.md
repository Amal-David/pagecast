# Pagecast — agent plugin

Lets your coding agent (Claude Code, Codex, or any Agent-Skills-compatible tool)
offer to publish a freshly created **HTML or Markdown** report, plan, or doc to a
shareable public URL—and execute an explicit Pagecast request immediately.

How it works: a passive `PostToolUse` hook notices when an HTML/Markdown file is
written and hints the agent. The `publish-report` skill tells the agent to offer
(once, only for finished/shareable artifacts) *"Want me to publish this with
Pagecast?"* for proactive suggestions. When you say “Publish this as a
Pagecast,” that instruction is already consent and the agent runs the CLI:

```sh
npx pagecast publish "/absolute/path/file.md" --json
# → {"ok":true,"action":"created","url":"https://<home>.pages.dev/p/<token>/", ...}
```

## Setup (one time)

### 1. Install the agent integration

**Codex CLI / Codex desktop** — copy the Codex-native skill:

```sh
mkdir -p ~/.codex/skills
# from a clone of the repo:
cp -R .codex/skills/publish-report ~/.codex/skills/
```

Start a new Codex session so the skill is discovered. Then you can ask:

```text
Use $publish-report to publish /absolute/path/report.md with Pagecast.
```

**Claude Code** — add the marketplace from the public repo, then install:

```sh
/plugin marketplace add Amal-David/pagecast
/plugin install pagecast@pagecast
```

This wires up both the `publish-report` skill and the report-detection hook.

If Claude Code Artifacts are enabled, plain "publish this" requests can mean two
different things. The Pagecast skill asks whether you want a Claude Code Artifact
or a Pagecast Cloudflare Pages link. Say "publish this with Pagecast" when you
want to skip the choice and use the Cloudflare Pages URL path.

**Other Agent-Skills tools** — copy the portable skill:

```sh
# from a clone of the repo:
cp plugin/skills/publish-report/SKILL.md /path/to/your-agent/skills/publish-report/SKILL.md
```

The portable `SKILL.md` is the Agent-Skills format. The detection hook is
Claude-Code-specific; elsewhere the skill still triggers when a report is created
or when you ask to publish one.

### MCP-capable agents

If your agent supports MCP, you can connect it directly to Pagecast instead of
copying a skill file:

```json
{
  "mcpServers": {
    "pagecast": {
      "command": "npx",
      "args": ["pagecast", "mcp"]
    }
  }
}
```

This first MCP integration is stdio-only. Keep the Pagecast admin API private;
do not expose the admin port to a VPN or shared network. A hosted HTTP MCP
endpoint should be a separate hardening pass with its own authentication and
audit model.

### 2. Connect Cloudflare

```sh
npx pagecast
```

The main canvas shows **Connect Cloudflare**, the Wrangler permission scopes,
and an editable Pagecast Home subdomain. Cloudflare labels the authorizing app
Wrangler. Pagecast shows progress and resumes setup after consent; Settings is
not required. An interactive publish can also start this flow and resume itself.

## What to expect

Once installed and connected: when your agent writes a report, plan, dashboard, or
other shareable HTML/Markdown, it offers *"Want me to publish this with Pagecast?"*
Say **yes** and you get back a Cloudflare Pages URL you own. Say no and it drops
it—it won't nag. An explicit Pagecast instruction skips the extra question.
Repeating it for the same item and agent context updates the same URL; the JSON
result says `created` or `updated`. Use `--new-link` for another URL.

New links are unlisted capability URLs, not private links: anyone with the URL
can view one. Use `--password` when recipients must authenticate. Pagecast uses
the actual production origin returned by Cloudflare, which can differ from the
project-name hostname after a global subdomain collision.

For static web projects that should get a new share link, build first and publish
the generated entry file, such as `dist/index.html`.

For whole-site Cloudflare Pages deploys, use Pagecast's Wrangler abstraction:

```sh
npx pagecast pages deploy "/absolute/path/dist" --project pagecasthq --branch main --json
```

If you omit `--branch`, Pagecast deploys to `main`:

```sh
npx pagecast pages deploy "/absolute/path/dist" --project pagecasthq --json
```

Direct site deploys replace the target Pages project contents. They use separate
staging and do not change the Cloudflare project selected for managed `/p/...`
links. Use a separate target unless replacing that managed site is intentional;
use `npx pagecast` for source-folder build settings, URL renaming, re-sync, and
revoke controls.

## Requirements

- Node.js >= 20.19.0 and `npx` (the exact Wrangler `4.86.0` package is fetched on
  first native use; Docker includes the same pin).
- A Cloudflare account.

When upgrading from Pagecast v0.4, restart any background Pagecast process once
before the agent publishes. This lets v0.5 establish the workspace lease and
authenticated local command protocol.
