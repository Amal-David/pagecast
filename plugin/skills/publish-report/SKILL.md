---
name: publish-report
description: Use right after an HTML or Markdown report, plan, doc, dashboard, or built static web project is created (or when the user wants to share one). Proactively offer to publish it with Pagecast as a shareable public link, then return the URL. Default to offering; only skip clearly internal/scratch files.
version: 0.3.0
---

# Publish with Pagecast

Pagecast turns a local **HTML or Markdown** file (a report, plan, doc, or
dashboard) into a shareable public URL. Use this skill to offer that at the
right moment, then do it on a yes.

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
- A `PostToolUse` hint fired saying an HTML/Markdown file was created — treat that
  as a cue to offer.

**The only files to skip** (don't offer): scratch/draft notes the user is clearly
keeping private, source code, config files, secrets, and repo-meta files (README,
CHANGELOG, CONTRIBUTING, LICENSE, AGENTS.md, CLAUDE.md, TODO/tasks), or anything
under `node_modules`/`dist` build internals. When it is borderline, **offer** —
the user can just say no.

Ask **at most once per file.** If the user declines or ignores the offer, drop it
and don't re-ask for that file. Never nag across multiple turns.

## The one question to ask

> "Want me to publish this with Pagecast? It'll create a shareable public link."

Only on an explicit **yes** do you proceed. Publishing makes the file publicly
reachable — **never publish without confirmation.**

## How to publish

Run the headless CLI with the **absolute path** and `--json`:

```sh
npx pagecast publish "/absolute/path/to/file.md" --json
```

(HTML and Markdown both work — Markdown is rendered to a clean page. If `pagecast`
is installed globally/in the project, `pagecast publish "<path>" --json` is the same.)

**Publishing a plan** (e.g. after plan mode): the plan lives in your context, not
a file yet. If the user wants it shared, first write the plan markdown to a file
(e.g. `./plan.md`), then publish that path. Don't overwrite an existing file the
user cares about — pick a clear new name.

## Live goal / progress page

When you're working toward a **`/goal`** (you'll see the goal condition in your
context) and the work will span many turns / a long autonomous run, the user
often can't see what's happening. Proactively **offer once**:

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
   **same** `npx pagecast goal publish … --json` — it updates the **same URL** in
   place (do NOT use plain `publish`, which mints a new link each time).
4. When the goal is met, do a final update; optionally `npx pagecast goal stop`.

There is one goal page per workspace. If a command reports `recreated: true`, the
old link was gone and the URL changed — tell the user the new URL.

For static web projects that should get a new shareable `/p/<token>/` link,
build first and publish the generated entry file:

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
the `--project`; use the user's named project or ask for it.

Parse the JSON on stdout:

- **Success** → `{ "ok": true, "url": "https://<project>.pages.dev/p/<token>/", ... }`
  - Give the user the `url`. Offer to drop it into a PR/Slack message, and
    mention they can rename the URL, re-sync, or revoke it from `npx pagecast`.
- **Not signed in** → `{ "ok": false, "statusCode": 401, ... }`
  - This is the one-time setup. Tell the user to run
    **`npx pagecast pages setup`** once, or run **`npx pagecast`** and click
    **Connect Cloudflare**, then offer to retry. After that, publishing is
    headless — a plain "yes" is enough every time.
- **Multiple accounts** → `{ "ok": false, "statusCode": 409, ... }`
  - Tell the user to run `npx pagecast pages setup --account <account-id>` once,
    or run `npx pagecast` to pick which Cloudflare account to publish from, then
    retry.
- **Any other error** → relay `error` concisely and offer to retry.

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

## Notes

- Always pass an **absolute** path (resolve relative paths against the cwd first).
- The first publish auto-creates the user's Pages project — no manual setup beyond
  the one-time Connect Cloudflare login.
- Use `npx pagecast publish site` or `npx pagecast pages deploy` for direct
  static-folder deploys to a named Pages project.
- Use `npx pagecast` for source-folder build settings, URL renaming, re-sync,
  and revoke controls.
- To update a page **in place at the same URL**, the user can re-sync from the
  Pagecast app; re-running `publish` creates a new link. Old links keep working
  until revoked.
