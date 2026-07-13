---
name: publish-report
description: Publish local HTML, Markdown, or built static web projects with Pagecast as shareable public URLs. Use whenever Codex creates or finishes an .html, .htm, .md, .markdown, or static build output that a person could share (a report, plan, doc, dashboard, or analysis) — proactively offer to publish it without being asked — and whenever the user asks to publish, share, make a public link for, or send a local report/doc/dashboard/web project from terminal, Codex CLI, or Codex desktop.
version: 0.6.0
---

# Publish with Pagecast

Pagecast turns a local **HTML or Markdown** file (a report, plan, doc, or
dashboard) into a shareable public URL in the user's Pagecast Home. Execute an
explicit Pagecast request immediately; offer once when publishing would be
useful but the user did not request it.

## Consent and intent

- “Publish this as a Pagecast”, “Pagecast this”, or equivalent is sufficient
  consent. Run the publish command immediately and return the URL; do not ask
  again.
- A proactive suggestion still asks once before publishing.
- If the user asks only for the command, provide the command and do not run it.

## When to offer

**Default to offering.** Whenever you produce an `.html`/`.htm` or
`.md`/`.markdown` file that a person could reasonably share, proactively offer to
publish it — once, right after you finish making it. Do **not** wait to be asked,
and do **not** stay silent because you are unsure whether it is "worth it." If it
could be shared, offer.

This includes:

- A report you generated — test/coverage/Lighthouse/Playwright output, a data
  dashboard, an analysis, a "here's what I built/found" summary.
- A written plan, proposal, design doc, spec, release notes, or doc.
- A static web project that was just built, with a generated entry file such as
  `dist/index.html`, `build/index.html`, `out/index.html`, or `public/index.html`.
- Any time the user says "share", "publish", "make a link for", or "send" a doc.

**The only files to skip** (don't offer): scratch/draft notes the user is clearly
keeping private, source code, config files, secrets, and repo-meta files (README,
CHANGELOG, CONTRIBUTING, LICENSE, AGENTS.md, CLAUDE.md, TODO/tasks), or anything
under `node_modules`/`dist` build internals. When it is borderline, **offer** —
the user can just say no.

Ask **at most once per file.** If the user declines or ignores the offer, drop it
and don't re-ask for that file. Never nag across multiple turns.

## The proactive question

> "Want me to publish this with Pagecast? It'll create a shareable public link."

Only a proactive suggestion needs this follow-up. An explicit instruction to
publish with Pagecast already provides confirmation.

## How to publish

Run the headless CLI with the **absolute path** and `--json`:

```sh
npx pagecast publish "/absolute/path/to/file.md" --json
```

(HTML and Markdown both work — Markdown is rendered to a clean page. If `pagecast`
is installed globally/in the project, `pagecast publish "<path>" --json` is the same.)

New links are **unlisted capability URLs**: a memorable prefix plus 128 bits of
opaque entropy. Anyone with the URL can view it; unlisted does not mean private.
The user can rename a link, add password protection, or make a short, shareable
"drop" link from the `npx pagecast` app. Existing word-only links remain valid.

Managed links live in one user-level Home at `~/.pagecast/home/`, under
`/p/<slug>/`. The same item in the same agent context updates the existing URL;
a new item or context creates a new URL. Pagecast stores only a local hash of
the agent context identifier.

### Publish options

Add any of these to a `publish` command:

- `--expires <7d|12h|never>` — edge-enforced link expiry (default 30d). The page
  returns 410 once expired; `--expires never` keeps it live until revoked. The
  result JSON reports `expiresAt` (or none when never).
- `--password "<pw>"` — gate the page behind a password, enforced at the edge so
  every file of a multi-file report is covered. `--no-password` removes protection.
  The result JSON reports `passwordProtected: true`.
- `--label "<name>"` — set the page's display name in the Pagecast app.
- `--context-id "<id>"` — explicitly select the local agent context.
- `--new-link` — force a fresh URL.
- `--update "<url|slug|token>"` — update a known publication.
- `--non-interactive` — never open browser authentication; return a structured
  authentication-required result instead.

```sh
npx pagecast publish "/absolute/path/to/report.html" --expires 7d --password "hunter2" --json
```

**Publishing a plan** (e.g. after plan mode): the plan lives in your context, not
a file yet. If the user wants it shared, first write the plan markdown to a file
(e.g. `./plan.md`), then publish that path. Don't overwrite an existing file the
user cares about — pick a clear new name.

## Live goal / progress page

When you're working toward a **`/goal`** (a long autonomous run the user can't
easily watch), the user often can't see what's happening. Proactively **offer
once**:

> "Want me to publish a live progress page for this goal? You'll get a public
> link you can open anytime to see status and what's done."

On an explicit **yes**:

1. Write a `pagecast-goal.md` in the working dir with the goal, status, a
   done/next checklist, and a one-line "latest", e.g.:
   ```markdown
   # <short goal title>

   **Goal:** <the goal condition, in your own words>
   **Status:** In progress · updated <time>
   **Progress:** 3 / 8 steps

   ## Done
   - [x] <step>

   ## Next
   - [ ] <step>

   ## Latest
   <one line: what you just did / any blocker>
   ```
2. Run `npx pagecast goal publish "<abs path>/pagecast-goal.md" --json` and give
   the user the returned `url`.
3. **After each meaningful step**, rewrite `pagecast-goal.md` and re-run the
   **same** `npx pagecast goal publish … --json` — it guarantees the dedicated
   goal URL and keeps goal lifecycle separate from normal context upserts.
4. When the goal is met, do a final update; optionally `npx pagecast goal stop`.

There is one goal page per workspace. If a command reports `recreated: true`, the
old link was gone and the URL changed — tell the user the new URL.

## Static web projects

For a static web project that should get a new shareable `/p/<slug>/` link, build
first and publish the generated entry file:

```sh
npm run build
npx pagecast publish "/absolute/path/to/dist/index.html" --json
```

If the user asks to deploy or update an entire static site/project, deploy the
built folder directly to a named Cloudflare Pages project:

```sh
npx pagecast publish site "/absolute/path/to/dist" --project "project-name" --branch main --json
```

`--branch` is optional and defaults to `main`, so this also works:

```sh
npx pagecast pages deploy "/absolute/path/to/dist" --project "project-name" --json
```

Use this instead of raw Wrangler commands like `npx wrangler pages deploy`.
Direct site deploys replace the target Pages project contents, so do not guess
the `--project`; use the user's named project or ask for it. Direct deploys do
not change Pagecast's managed `/p/...` target, so use a separate project unless
replacing that managed site is intentional.

## Reading the result

Parse the JSON on stdout:

- **Success** → `{ "ok": true, "action": "created" | "updated", "publicationToken": "...", "contextMatched": true | false, "url": "https://<home>.pages.dev/p/<slug>/", ... }`
  - Give the user the `url` and say whether Pagecast created or updated it.
- **Not signed in** → `{ "ok": false, "statusCode": 401, ... }`
  - Interactive publishing normally starts Wrangler's browser authorization and
    resumes automatically. This result is expected only for CI,
    `--non-interactive`, rejection, or timeout; relay it without sending the user
    to Settings.
- **Multiple accounts** → `{ "ok": false, "statusCode": 409, ... }`
  - Open `npx pagecast`, choose the Home account in the main onboarding canvas,
    then retry. Settings remains available for later account switching.
- **Any other error** → relay `error` concisely and offer to retry. Do not claim
  success.

## Cloudflare Pages commands

Use these lower-level commands when the user explicitly asks about Cloudflare
setup, status, project listing, or direct Pages deployment:

```sh
npx pagecast pages setup --project "project-name" --json
npx pagecast pages status --json
npx pagecast pages projects list --json
npx pagecast pages deploy "/absolute/path/to/dist" --project "project-name" --branch main --json
```

If the user does not specify a branch, omit `--branch`; Pagecast deploys to
`main`.

## Codex usage notes

- Always pass an **absolute** path (resolve relative paths against the cwd first).
- Run commands in the user's project so Pagecast can derive workspace and source
  identity; publication ownership stays in the user-level Home.
- The first interactive publish starts Wrangler login, creates the Home, and
  resumes automatically.
- If the user asks only for a command, provide it instead of running it. If they
  explicitly ask Codex to publish with Pagecast, run it immediately.
- Re-running `publish` for the same item and agent context updates the same URL.
  Use `--new-link` only when the user asks for another URL.
