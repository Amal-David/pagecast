# Pagecast

Preview local HTML reports and static mini apps, then publish them to shareable
URLs.

**Live:** <https://pagecasthq.pages.dev/>

## Run (one command)

```sh
npx pagecast
```

This starts the local app and opens the admin UI in your browser. From a clone you
can also use `npm start`. By default:

- Admin UI: `http://127.0.0.1:4173`
- Local report server: `http://127.0.0.1:4174`

The data directory (`.pagecast/`) is created in your current working folder.

## Publish from the command line (headless)

```sh
npx pagecast publish "/absolute/path/report.html" --json
# → {"ok":true,"url":"https://<project>.pages.dev/p/<token>/", ...}
```

If you are not signed in yet it returns `{"ok":false,"statusCode":401}` telling you
to run `npx pagecast` once and click **Connect Cloudflare**.

## Use it from your coding agent

When your agent (Claude Code, Codex, or any Agent-Skills tool) finishes an HTML or
Markdown report, plan, or doc, it offers — *"Want me to publish this with
Pagecast?"* — and on a **yes** ships a public `pagecast.pages.dev` link you own.

**Setup is two one-time steps:**

1. **Install the plugin.**
   - Claude Code:
     ```sh
     /plugin marketplace add Amal-David/pagecast
     /plugin install pagecast@pagecast
     ```
   - Codex / others: copy `plugin/skills/publish-report/SKILL.md` into
     `~/.codex/skills/publish-report/` (it's the portable Agent-Skills format).
2. **Connect Cloudflare** (one click, free): run `npx pagecast` and click
   **Connect Cloudflare** — or `npx wrangler login --scopes account:read --scopes user:read --scopes pages:write`.

After that, publishing is headless: the agent asks once for finished, shareable
artifacts (never for scratch/internal files), and a plain "yes" publishes. Full
details in [`plugin/README.md`](plugin/README.md).

## Usage

The admin UI is a clean, light shadcn interface. Core actions:

- Paste an absolute `.html`, `.htm`, `.md`, or `.markdown` file path, or a `file:///...` URL, to serve the page from its current folder.
- Add a deployable static folder, or a source folder with an explicit build command and output directory.
- Drop or choose HTML/Markdown files and browser-supported folder uploads to cache local copies under `.pagecast/`.
- **Drag to reorder** reports in the list; the order is saved.
- Use **Publish URL** on a page to create a published copy you can share.
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
npx wrangler pages deploy .pagecast/pages-site --project-name pagecast --branch main
```

One-click setup:

1. Open the Cloudflare Pages panel and press **Connect Cloudflare**.
2. Pagecast logs you in only if needed (scoped OAuth: `account:read`,
   `user:read`, `pages:write`), auto-detects your account, and **auto-creates the
   Pages project** if you don't have one yet. No account ID to paste, no Refresh to
   press — the panel updates itself and shows the connected account and project.
3. If you have more than one Cloudflare account, a small chooser appears so you can
   pick which one to publish from; otherwise it is skipped entirely.

Then press **Publish URL** on any report to publish it.

For mini apps, Pagecast publishes static build output. React/Vite-style apps
should point at a deployable output folder such as `dist`, or provide a build
command like `npm run build` plus output directory. Python projects must export
static assets first; Pagecast does not run a Python web server on Cloudflare Pages.

For headless or automation use, create a scoped Cloudflare API token with Account >
Cloudflare Pages > Edit permission for the one account you want to use, then start
Pagecast with:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx pagecast
```

If Wrangler ever ignores scoped OAuth or Cloudflare's consent screen still looks broader than expected, cancel it and use the API token path.

Each snapshot is staged under `.pagecast/pages-site/p/<token>/` and published as:

```text
https://<project>.pages.dev/p/<token>/
```

Changing the local HTML file does not change an existing snapshot. Press **Snapshot** again to publish a new version. Revoking a snapshot removes its staged folder and redeploys the Pages site, so that exact link stops resolving after Cloudflare finishes the deploy.

The Pages root does not publish a report listing. The generated static site only contains the exact `/p/<token>/` snapshot folders, a `404.html`, and no-store response headers.

## Security Model

The admin UI binds to `127.0.0.1`. Public sharing happens only through Cloudflare Pages.

Draft report previews use the admin-only `/preview/:id/` route. The public server does not serve draft `/r/:id/` URLs. Public access only works for exact active publication links under `/p/:token/`, and revoked publication tokens return 404.

Public report routes reject parent-directory traversal plus hidden-file paths.

Path-based reports serve sibling assets from the same folder so relative CSS, images, and scripts keep working. Snapshot publishing copies non-hidden files from that folder into the staged snapshot. Anyone with the public URL can fetch non-hidden assets in that folder if they know the asset path.

## Verification

```sh
npm run check
npm test
```
