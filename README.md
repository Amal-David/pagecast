# Pagecast

Preview local HTML reports and publish them to durable **public URLs on your own
Cloudflare Pages account**. Two sharing modes:

- Durable static snapshots through Cloudflare Pages (the hero path).
- Live local links through Tailscale Funnel.

## Run (one command)

```sh
npx pagecast
```

This starts the local app and opens the admin UI in your browser. From a clone you
can also use `npm start`. By default:

- Admin UI: `http://127.0.0.1:4173`
- Local report server: `http://127.0.0.1:4174`

The data directory (`.html-reporter/`) is created in your current working folder.

## Publish from the command line (headless)

```sh
npx pagecast publish "/absolute/path/report.html" --json
# → {"ok":true,"url":"https://<project>.pages.dev/p/<token>/", ...}
```

If you are not signed in yet it returns `{"ok":false,"statusCode":401}` telling you
to run `npx pagecast` once and click **Connect Cloudflare**.

## Use it from your coding agent

The `plugin/` directory is a Claude Code plugin (and portable Agent-Skills skill)
that makes your agent offer to publish reports it generates. See
`plugin/README.md` for install steps in Claude Code and Codex.

## Usage

The admin UI is a clean, light shadcn interface. Core actions:

- Paste an absolute `.html` or `.htm` file path, or a `file:///...` URL, to serve the report from its current folder.
- Drop or choose an HTML file to cache a local copy under `.html-reporter/`.
- **Drag to reorder** reports in the list; the order is saved.
- Use **Snapshot** on a report to publish a durable Cloudflare Pages copy that keeps working when the laptop is closed.
- Use **Live** on a report to create a versioned Tailscale link such as `v1`, `v2`, etc.
- Use **Revoke** on a version to disable only that exact link, or **Revoke all** to disable every published version for one report.

### Edit the URL, sync, and edit the HTML

- **Edit the URL** of a published page: rename its slug to a friendly path. The old
  link **301-redirects** to the new one, so anything you already shared keeps working.
  (Random slugs are unguessable; a custom vanity slug is shareable but guessable — the
  default stays random, custom is opt-in.)
- **Sync / republish** updates a published page **in place at the same URL** — the link
  you shared always shows the latest content.
- **Auto-sync** watches a path report's source file (read-only) and republishes the same
  URL automatically whenever the file changes.
- **Editor mode** lets you edit a report's HTML in-app (CodeMirror) and republish. Edits
  are saved to a pagecast-managed working copy — your original files are never overwritten.

## Cloudflare Pages Snapshots

Snapshot links use Cloudflare Pages Direct Upload through Wrangler:

```sh
npx wrangler pages deploy .html-reporter/pages-site --project-name html-reporter --branch main
```

One-click setup:

1. Open the Cloudflare Pages panel and press **Connect Cloudflare**.
2. Pagecast logs you in only if needed (scoped OAuth: `account:read`,
   `user:read`, `pages:write`), auto-detects your account, and **auto-creates the
   Pages project** if you don't have one yet. No account ID to paste, no Refresh to
   press — the panel updates itself and shows the connected account and project.
3. If you have more than one Cloudflare account, a small chooser appears so you can
   pick which one to publish from; otherwise it is skipped entirely.

Then press **Snapshot** on any report to publish it.

For headless or automation use, create a scoped Cloudflare API token with Account >
Cloudflare Pages > Edit permission for the one account you want to use, then start
Pagecast with:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx pagecast
```

If Wrangler ever ignores scoped OAuth or Cloudflare's consent screen still looks broader than expected, cancel it and use the API token path.

Each snapshot is staged under `.html-reporter/pages-site/p/<token>/` and published as:

```text
https://<project>.pages.dev/p/<token>/
```

Changing the local HTML file does not change an existing snapshot. Press **Snapshot** again to publish a new version. Revoking a snapshot removes its staged folder and redeploys the Pages site, so that exact link stops resolving after Cloudflare finishes the deploy.

The Pages root does not publish a report listing. The generated static site only contains the exact `/p/<token>/` snapshot folders, a `404.html`, and no-store response headers.

## Tailscale Live Links

The public URL uses Tailscale Funnel:

```sh
tailscale funnel --bg --yes --https=443 http://127.0.0.1:4174
```

Tailscale is currently installed on this laptop. Start or sign in to Tailscale before pressing **Start URL**. Funnel also has to be enabled for the tailnet; if Tailscale returns an enable link, open it and approve Funnel in the Tailscale admin flow.

Tailscale Funnel gives a stable `https://...ts.net` base URL. Pagecast publishes independent live versions under that base path, such as `/p/v1-.../`, `/p/v2-.../`, and `/p/client-demo-.../`.

Live links serve path-based reports from disk, so edits to the local HTML file refresh on reload. Live links stop working when the laptop is offline, asleep, or the Funnel is revoked.

## Security Model

The admin UI binds to `127.0.0.1`. Only the report server is meant to be exposed through Tailscale.

Draft report previews use the admin-only `/preview/:id/` route. The public server does not serve draft `/r/:id/` URLs. Public access only works for exact active publication links under `/p/:token/`, and revoked publication tokens return 404.

Public report routes reject parent-directory traversal plus hidden-file paths.

Path-based reports serve sibling assets from the same folder so relative CSS, images, and scripts keep working. Snapshot publishing copies non-hidden files from that folder into the staged snapshot. Anyone with the public URL can fetch non-hidden assets in that folder if they know the asset path.

## Verification

```sh
npm run check
npm test
```
