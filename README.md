# Pagecast

Preview local HTML reports, Markdown docs, and static mini apps, then publish
them to shareable Cloudflare Pages URLs from the terminal or your coding agent.

**Live app:** <https://pagecasthq.pages.dev/>

## About

Pagecast is a local-first publishing tool for agent-generated reports and small
static web projects. It gives you a local admin UI for previewing files, managing
published versions, renaming links, re-syncing updates, and revoking old URLs.
For automation, it exposes headless `pagecast publish` commands, a small
Cloudflare Pages CLI abstraction, and Codex / Claude agent skills.

Good fits:

- HTML reports, dashboards, coverage output, Playwright or Lighthouse reports.
- Markdown plans, proposals, release notes, docs, and summaries.
- Static mini apps from build folders such as `dist`, `build`, `out`, or
  `public`.
- Coding-agent workflows that should ask before publishing a finished artifact.

Not a fit:

- Private drafts or scratch notes.
- Server-rendered apps that need a running backend.
- Python/Ruby/Node services unless they first export static assets.

## Requirements

- Node.js 20 or newer.
- `npx` for one-command use.
- A Cloudflare account for public publishing.
- `pnpm` only when rebuilding the web UI from `web/`.

The root CLI/server has no runtime npm dependencies. The React admin UI is built
from `web/` into `public/` and is already included in the package.

## Install And Run

Use Pagecast without installing it globally:

```sh
npx pagecast
```

This starts the local app and opens the admin UI.

- Admin UI: `http://127.0.0.1:4173`
- Local published-page server: `http://127.0.0.1:4174`
- Local data/config: `.pagecast/` in your current working directory

Use the admin UI on `4173` for normal work. The `4174` server is intentionally
separate: it serves local published-page routes such as `/p/<slug>/` so Pagecast
can preview the same URL shape it deploys to Cloudflare Pages. Its root path is
not an app and returns `404`; use `/healthz` only to check that it is running.

From a clone:

```sh
git clone https://github.com/Amal-David/pagecast.git
cd pagecast
npm start
```

## First-Time Cloudflare Setup

Run the app once:

```sh
npx pagecast
```

Open the Cloudflare Pages panel and click **Connect Cloudflare**. Pagecast uses
scoped Wrangler OAuth (`account:read`, `user:read`, `pages:write`), detects your
account, and creates the Pages project if needed.

Or do the same setup from the terminal:

```sh
npx pagecast pages setup --project pagecast
```

If you prefer a token for automation, create a scoped Cloudflare API token with
Account > Cloudflare Pages > Edit permission, then run:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx pagecast pages status --json
```

If more than one Cloudflare account is available, Pagecast asks you to choose the
account once in the admin UI, or you can pass it directly:

```sh
npx pagecast pages setup --account 90e4c638bea527f464ec6fa7caebfd4e --project pagecast
```

## Publish From The Terminal

Publish an HTML file:

```sh
npx pagecast publish "/absolute/path/report.html" --json
# -> {"ok":true,"url":"https://<project>.pages.dev/p/<token>/", ...}
```

Publish Markdown:

```sh
npx pagecast publish "/absolute/path/report.md" --json
```

Publish a static web project as a shareable snapshot by building first, then
publishing the generated entry file:

```sh
npm run build
npx pagecast publish "$(pwd)/dist/index.html" --json
```

This creates a `/p/<token>/` link and stages sibling assets from the build
folder.

Deploy a whole static folder directly to a named Cloudflare Pages project:

```sh
npx pagecast publish site "$(pwd)/dist" --project pagecasthq --branch main --json
```

`--branch` is optional. If you omit it, Pagecast deploys to `main`:

```sh
npx pagecast pages deploy "$(pwd)/dist" --project pagecasthq --json
```

That command is the Pagecast abstraction over raw Wrangler deploys. It replaces:

```sh
CLOUDFLARE_ACCOUNT_ID=90e4c638bea527f464ec6fa7caebfd4e npx wrangler pages deploy /private/tmp/pagecasthq-deploy --project-name pagecasthq --branch main
```

with:

```sh
npx pagecast pages deploy /private/tmp/pagecasthq-deploy --project pagecasthq --branch main --json
```

Direct site deploys replace the target Pages project contents. For source-folder
build settings, link renaming, re-sync, and revoke controls, use the app:

```sh
npx pagecast
```

Common headless errors:

- `{"ok":false,"statusCode":401}`: run `npx pagecast pages setup` once, or run
  `npx pagecast` and connect Cloudflare.
- `{"ok":false,"statusCode":409}`: pass `--account <account-id>`, or run
  `npx pagecast` once and choose the Cloudflare account.

## Cloudflare Pages Commands

Pagecast wraps the Wrangler commands needed for normal Pages publishing:

```sh
npx pagecast pages setup --project pagecast --json
npx pagecast pages status --json
npx pagecast pages projects list --json
npx pagecast pages deploy "/absolute/path/dist" --project pagecasthq --branch main --json
npx pagecast pages deploy "/absolute/path/dist" --project pagecasthq --json
```

Agents and CI should prefer `--json`. Human terminal output stays concise by
default. Direct deploys use `main` when `--branch` is not provided.

## Use From Codex And Other Agents

Pagecast includes a Codex-native skill and a portable Agent-Skills file. The
skill tells the agent to offer once for finished, shareable HTML/Markdown/static
artifacts and to publish only after explicit confirmation.

### Codex CLI Or Codex Desktop

From a clone of this repo:

```sh
mkdir -p ~/.codex/skills
cp -R .codex/skills/publish-report ~/.codex/skills/
```

Start a new Codex session, then ask:

```text
Use $publish-report to publish /absolute/path/report.md with Pagecast.
```

For a web project:

```text
Use $publish-report to build this project and publish dist/index.html with Pagecast.
```

### Claude Code

```sh
/plugin marketplace add Amal-David/pagecast
/plugin install pagecast@pagecast
```

This installs the portable `publish-report` skill and the Claude Code
report-detection hook.

### Other Agent-Skills Tools

Copy the portable skill into your agent's skills folder:

```sh
cp plugin/skills/publish-report/SKILL.md /path/to/your-agent/skills/publish-report/SKILL.md
```

More detail is in [plugin/README.md](plugin/README.md).

## Admin UI Features

- Add `.html`, `.htm`, `.md`, and `.markdown` files by absolute path or
  `file:///...` URL.
- Add deployable static folders.
- Add source folders with an explicit build command and output directory.
- Drop or choose HTML/Markdown files and browser-supported folder uploads.
- Drag to reorder reports.
- Publish a shareable URL, revoke one version, or revoke all versions for a
  report.
- Rename a published URL. Old links redirect to the new path.
- Re-sync a published page in place at the same URL.
- Enable auto-sync for path-backed reports.
- Edit HTML in the app without overwriting the original source file.

## Local Development

Run the packaged app from source:

```sh
npm start
```

Run the verification suite:

```sh
npm run check
npm test
```

Rebuild the React admin UI into `public/`:

```sh
npm run build
```

Work on the React UI with Vite:

```sh
pnpm -C web install --frozen-lockfile --ignore-scripts
npm start
pnpm -C web run dev
```

Vite runs on `http://127.0.0.1:5173` and proxies `/api`, `/preview`, and `/p` to
the local Pagecast server on `http://127.0.0.1:4173`.

## Project Layout

```text
src/                         Node CLI, server, Cloudflare Pages publisher
public/                      Built admin UI served by the package
web/                         Vite + React source for the admin UI
plugin/                      Claude/portable Agent-Skills integration
.codex/skills/publish-report/ Codex-native Pagecast skill
llms.txt                     Agent-readable command and workflow map
test/                        Node test suite
```

## Packaging And Release Checks

Before publishing a package:

```sh
npm run build
npm run check
npm test
npm pack --dry-run
```

The npm package includes `src/`, `public/`, `plugin/`, `llms.txt`, and the Codex
skill under `.codex/skills/publish-report/`.

## Security Model

- The admin UI binds to `127.0.0.1`.
- Draft previews are admin-only local routes.
- Public access works only through active `/p/<token>/` publication links.
- Revoked publication tokens return 404 after the Pages redeploy finishes.
- Public report routes reject parent-directory traversal and hidden-file paths.
- Path-based reports and snapshots include non-hidden sibling assets from the
  report folder, so anything in that folder can become public if referenced or
  guessed.
- The Pages root does not publish a report listing.

## License

Pagecast is released under the MIT License. See [LICENSE](LICENSE).

## Contributing

Issues and pull requests are welcome. Keep changes focused, run the verification
commands above, and rebuild `public/` with `npm run build` whenever you change
files under `web/`.
