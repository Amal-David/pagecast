---
name: publish-report
description: Publish local HTML, Markdown, or built static web projects with Pagecast as shareable public URLs. Use whenever Codex creates or finishes an .html, .htm, .md, .markdown, or static build output that a person could share (a report, plan, doc, dashboard, or analysis) — proactively offer to publish it without being asked — and whenever the user asks to publish, share, make a public link for, or send a local report/doc/dashboard/web project from terminal, Codex CLI, or Codex desktop.
---

# Publish With Pagecast

## Overview

Use Pagecast to turn a finished local artifact into a shareable public URL backed
by the user's Cloudflare Pages project. Prefer `pagecast publish <file>` for
reports, docs, and built entry files. Use `pagecast publish site <dir>` only when
the user intentionally wants to deploy a whole static folder to a named
Cloudflare Pages project.

Never publish without explicit confirmation. Publishing makes the selected
artifact publicly reachable.

## Be Proactive

**Default to offering.** Right after you create or finish a shareable file, offer
once to publish it — do not wait for the user to ask, and do not stay silent
because you are unsure it is "worth it." If it could be shared, offer. When it is
borderline, offer anyway; the user can say no.

## What To Publish

Proactively offer once for any shareable artifact you produce:

- HTML reports, dashboards, coverage reports, Playwright/Lighthouse output, or
  static single-page mini apps.
- Markdown reports, plans, docs, proposals, release notes, analyses, or summaries
  meant to be read by someone else. (A plan you just finished can be shared too —
  write it to a `.md` file first, then publish that path.)
- Static web projects after they are built. Publish the generated entry file,
  usually `dist/index.html`, `build/index.html`, `out/index.html`, or
  `public/index.html`; Pagecast stages sibling assets from that output folder.

Only skip (do not offer) clearly non-shareable files: scratch/draft notes the
user is keeping private, source files, repo metadata (README/CHANGELOG,
AGENTS.md/CLAUDE.md), task files, secrets, config files, dependency/build
folders, and hidden files.

## Confirmation

Ask one direct question before publishing:

```text
Want me to publish this with Pagecast?
```

Proceed only after an explicit yes. If the user declines or ignores the offer,
drop it and do not ask again for that artifact.

## Headless CLI Workflow

Resolve the target to an absolute path, then run:

```sh
npx pagecast publish "/absolute/path/to/report-or-built-index.html" --json
```

Markdown works too:

```sh
npx pagecast publish "/absolute/path/to/report.md" --json
```

For a web project that should get a new shareable `/p/<token>/` link:

1. Run the project's existing build command, such as `npm run build`, only if the
   user expects the current project state to be published.
2. Find the static output entry file, usually `dist/index.html`,
   `build/index.html`, `out/index.html`, or `public/index.html`.
3. Publish that entry file with `npx pagecast publish "<absolute-entry-path>" --json`.

If the user asks to deploy or update an entire static site/project rather than
create a new share link, deploy the built folder directly:

```sh
npx pagecast publish site "/absolute/path/to/dist" --project "project-name" --branch main --json
```

`--branch` is optional and defaults to `main`, so this also works:

```sh
npx pagecast pages deploy "/absolute/path/to/dist" --project "project-name" --json
```

Use this instead of raw Wrangler commands like `npx wrangler pages deploy`.
Direct site deploys replace the target Cloudflare Pages project contents, so do
not guess the `--project`; use the user's named project or ask for it.

Parse stdout as JSON:

- Success: `{ "ok": true, "url": "https://<project>.pages.dev/p/<token>/", ... }`
  Return the `url` and mention that the user can rename, re-sync, or revoke it
  from `npx pagecast`.
- `401`: the user has not connected Cloudflare. Tell them to run
  `npx pagecast pages setup` once, or run `npx pagecast` and click
  **Connect Cloudflare**, then retry if they want.
- `409`: multiple Cloudflare accounts are available. Tell them to run
  `npx pagecast pages setup --account <account-id>` once, or run `npx pagecast`
  and choose the account, then retry.
- Other errors: relay the error concisely and do not claim success.

## Cloudflare Pages Workflow

Use these lower-level commands when the user explicitly asks about Cloudflare
setup or project deployment:

```sh
npx pagecast pages setup --project "project-name" --json
npx pagecast pages status --json
npx pagecast pages projects list --json
npx pagecast pages deploy "/absolute/path/to/dist" --project "project-name" --branch main --json
```

If the user does not specify a branch, omit `--branch`; Pagecast deploys to
`main`.

`pages deploy` is the Pagecast abstraction over `npx wrangler pages deploy`; it
passes the account to Wrangler internally through `CLOUDFLARE_ACCOUNT_ID` when
needed.

## Live Goal / Progress Page

When working toward a `/goal` (a long autonomous run the user can't easily watch),
proactively offer once: "Want me to publish a live progress page you can check
anytime?" On an explicit yes:

1. Write a `pagecast-goal.md` with the goal, status, a done/next checklist, and a
   one-line "latest".
2. `npx pagecast goal publish "/abs/pagecast-goal.md" --json` → give the user the
   `url`.
3. After each meaningful step, rewrite the file and re-run the **same** command —
   it updates the **same URL** in place. Do NOT use plain `publish` (mints a new
   link). `npx pagecast goal stop` when done.

One goal page per workspace; if a result has `recreated: true`, the URL changed —
surface the new one.

## App Workflow

Use the app when the user needs to manage folders or existing links:

```sh
npx pagecast
```

The app opens at `http://127.0.0.1:4173` and supports:

- Adding HTML/Markdown files.
- Adding deployable static folders.
- Adding source folders with an explicit build command and output directory.
- Publishing, renaming, re-syncing, and revoking URLs.

## Codex Usage Notes

- From Codex CLI or desktop, run terminal commands in the user's current project
  directory so `.pagecast/` config and publish history stay with that project.
- Always use absolute paths in `pagecast publish` and `pagecast pages deploy`.
- If the user asks only for a command, provide the command and any one-time setup
  note instead of running it.
- If the user asks Codex to publish, run the command after confirmation and
  report the resulting URL or exact failure.
