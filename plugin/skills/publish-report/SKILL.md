---
name: publish-report
description: Use when an HTML report (or any .html/.htm report file) has just been created or the user wants to share a report as a public link. Offers to publish it to a durable public URL on the user's own Cloudflare Pages account via the pagecast CLI, then returns the URL.
version: 0.1.0
---

# Publish a report with HTML Reporter

HTML Reporter turns a local HTML report into a durable public URL hosted on the
**user's own Cloudflare Pages account**. Use this skill to offer that, then do it.

## When to offer

Offer to publish when **any** of these is true:

- An `.html` / `.htm` report file was just generated (test report, coverage,
  Lighthouse, Playwright trace HTML, a data dashboard, a "here's what I built"
  summary, etc.).
- The user asks to "share", "publish", "make a link for", or "send" a report.
- A `PostToolUse` hint says a report file was created (see the bundled hook).

Do **not** publish silently. Publishing makes the report publicly reachable, so
**always ask first** and only proceed on an explicit "yes".

## The one question to ask

> "Should I publish this with the reporter? It will create a durable public URL
> on your own Cloudflare account."

If the user says yes, proceed. If no, stop and do nothing.

## How to publish

Run the headless CLI with the **absolute path** to the report and `--json`:

```sh
npx pagecast publish "/absolute/path/to/report.html" --json
```

(If `pagecast` is installed globally or in the project, `pagecast
publish "<path>" --json` works the same.)

Parse the JSON printed on stdout:

- **Success** → `{ "ok": true, "url": "https://<project>.pages.dev/p/<token>/", "token": "...", "projectName": "..." }`
  - Give the user the `url`. Mention it is a durable snapshot on their own
    Cloudflare account (it keeps working when their laptop is closed), and that
    they can revoke it later from `npx pagecast` or by re-running the
    tool. Offer to copy it into a PR/Slack message if relevant.
- **Not signed in** → `{ "ok": false, "statusCode": 401, "error": "Not signed in to Cloudflare..." }`
  - Tell the user to run **`npx pagecast`** once, click **Connect
    Cloudflare** (a one-click scoped login — no account ID needed), then ask if
    they want you to retry the publish.
- **Multiple accounts** → `{ "ok": false, "statusCode": 409, ... }`
  - Tell the user to run `npx pagecast` once to choose which
    Cloudflare account to publish from, then retry.
- **Any other error** → relay `error` concisely and offer to retry.

## Notes

- Always pass an absolute path. If you only have a relative path, resolve it
  against the working directory first.
- The first publish on a fresh account auto-creates the Pages project — no
  manual setup is required beyond the one-time Connect Cloudflare login.
- Re-running publish on a changed file creates a **new** snapshot URL; the old
  one keeps serving the old content until revoked.
