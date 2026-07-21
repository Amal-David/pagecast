# Changelog

All notable changes to Pagecast are documented here. This project follows
[semantic versioning](https://semver.org/).

## Unreleased

## 0.6.1 — 2026-07-21

### Added

- **Skills.sh installation support** — the packaged publishing skill now has a
  one-command install path and agent-readable catalog guidance.
- **Real Settings navigation and Analytics destination** — Settings sidebar
  items open their actual sections, analytics uses the saved configuration, and
  page actions remain available on one row.

### Fixed

- **Activity credential migration** — compatible legacy feedback credentials
  move into Pagecast Home only when both Pages targets use the same Cloudflare
  account.
- **Wrangler D1 provisioning compatibility** — Activity setup retries without
  `--json` when the installed Wrangler version rejects that option.
- **Telemetry command coverage** — ingestion accepts the current CLI's
  background, local URL, setup, and open command classifications while keeping
  unknown command input anonymized.

## 0.6.0 — 2026-07-14

### Added

- **Pagecast Home** — one user-level Cloudflare subdomain and managed state store
  now owns publications across workspaces; `--data-dir` remains an explicit
  isolated profile and legacy targets remain quarantined until chosen.
- **Agent-context upserts** — CLI and MCP publishing update the same item in the
  same hashed agent context, with `--new-link`, `--update`, and created/updated
  JSON results.
- **Main-canvas Cloudflare onboarding** — resumable Wrangler authorization jobs,
  Home subdomain confirmation, scope explanation, account selection, and retry
  live outside Settings.
- **Privacy-preserving Activity** — D1 access events, anonymous HMAC visitors,
  30-day detailed retention, legacy KV-total migration, per-link summaries, and
  Home-wide Activity. Analytics and reactions are independently enabled.

### Changed

- Explicit “Publish this as a Pagecast” instructions are sufficient consent and
  packaged skills execute them immediately; proactive suggestions still ask.
- Interactive unauthenticated publishes start Wrangler login and resume the
  original operation. Non-interactive runs fail structurally.
- **Anonymous CLI telemetry default** — fresh installs now enable
  the existing allowlisted telemetry by default and show a disclosure. Users can
  opt out with `pagecast telemetry disable`, `PAGECAST_TELEMETRY=0`, or
  `DO_NOT_TRACK=1`; CI remains disabled unless explicitly enabled.

## 0.5.0 — 2026-07-10

### Added

- **Separate preview trust boundary** — report HTML now comes from the local
  public/preview origin, never the admin origin. Admin redirects old
  `/preview/...` requests and embeds previews with a restrictive iframe sandbox.
- **Authenticated local mutations** — browser writes require an allowed Origin
  and current admin-session token; every no-Origin write uses the private
  workspace capability; the Chrome extension is limited to its three adapter
  routes. Non-loopback binds are rejected, with an explicit wildcard exception
  only for the packaged loopback-mapped Docker proxy.
- **Project-scoped publication state** — Cloudflare identity is the account ID
  plus project name. Snapshots, redirects, protection manifests, and deployment
  staging are isolated by that identity and carry a Pagecast ownership marker.
- **Single-writer recovery** — a workspace lease, private runtime descriptor,
  atomic local state writes, and durable cross-system operation journal prevent
  concurrent CLI/MCP/server mutations from silently losing updates and keep
  incomplete Cloudflare reconciliation visible and retryable.
- **Stronger new unlisted URLs** — newly generated unlisted and protected slugs
  combine a memorable prefix with 128 bits of opaque capability entropy. Short
  drops and every existing word-only URL keep their previous behavior.
- **Cross-platform and release proofs** — CI now covers Node 20/22 on Linux and
  Windows, plus committed UI bundle, package, and Docker checks on Linux.

### Changed

- **Explicit target adoption** — unrelated existing Cloudflare projects are not
  silently managed. Legacy links without a recorded account/project stay
  readable and require **Attach selected project** before sync, rename, expiry,
  or revoke.
- **Direct deploy separation** — `pagecast pages deploy` uses target/branch-scoped
  staging and never changes the managed `/p/...` publication selection. It still
  replaces the named Pages project's contents.
- **Telemetry consent** — genuinely fresh installs send no telemetry until
  `pagecast telemetry enable`. Existing persisted choices and explicit
  environment overrides remain compatible.
- **Actual Cloudflare origin** — published URLs and social metadata use the
  production origin returned by deployment rather than assuming a project-name
  hostname.
- **Explicit vanity-link semantics** — custom slugs without the 128-bit
  capability suffix, including the goal URL, are recorded as public drops;
  existing word-only links retain their legacy classification and URL.
- **Native build shell** — source-folder commands use `sh -lc` on POSIX and
  `%ComSpec% /d /s /c` on Windows. Command syntax itself is still
  platform-specific.
- **Pinned publisher toolchain** — native and Docker publishing share the exact
  Wrangler `4.86.0` pin from `src/platform.js`; an exact-version override is
  available only for tests and deliberate local compatibility work.
- **Package boundary and versions** — the root export now has an explicit
  compatibility-preserving `src/index.js` boundary. npm package, Chrome
  extension, Codex skill, and Claude plugin metadata are aligned at `0.5.0`.

### Upgrade notes

- Restart any v0.4 background process once so v0.5 can own the workspace lease
  and authenticated command descriptor. Reload/update the bundled extension at
  the same time; old extension code cannot complete the new CSRF handshake.
- Existing URLs and persisted state are not rotated. For unattributed legacy
  links, select the original Cloudflare project and explicitly attach each link
  before attempting a mutation.
- A repository administrator must enable the new CI jobs as required `main`
  checks after merge; branch-protection settings cannot be changed by this PR.

## 0.4.0 — 2026-07-08

### Added

- **MCP server support** — `pagecast mcp` now runs a local stdio Model Context
  Protocol server with tools for status, page listing, content/file publishing,
  and publication revocation. (#16)
- **Agent-safe publishing defaults** — MCP `publish_content` writes supplied
  HTML/Markdown into isolated Pagecast storage, while `publish_file` excludes
  sibling assets unless both `includeAssets` and `confirmAssets` are set. (#16)
- **MCP documentation** — README now includes MCP client configuration, tool
  behavior, example arguments, and the current org/VPN deployment boundary.

### Fixed

- **Stdio response ordering** — MCP requests received together are handled
  serially so clients see responses in request order. (#16)

## 0.3.0 — 2026-07-07

### Added

- **Cloudflare sync-back** — import existing published Pages links into the
  dashboard, including pages created outside the current local workspace. (#15)
- **Preview workbench** — selected pages now show an embedded desktop/mobile
  preview with centered controls and a denser operator layout. (#15)
- **Persistent local URL** — macOS users can install `http://pagecast.localhost`
  and a login service so Pagecast can stay reachable after restart without a
  visible port. (#15)
- **Release automation** — GitHub releases now publish the npm package, push a
  GHCR Docker image, and attach a packaged Chrome extension zip.

### Fixed

- **Saved edits publish in place** — editing an already-published page now syncs
  the existing public URL instead of only saving a local draft. (#15)
- **Portless URL safety** — Pagecast falls back to the actual admin URL when the
  installed macOS redirect points at a different active port. (#15)

## 0.2.0 — 2026-06-26

### Added

- **Memorable links** — published pages now get human-readable word-slugs
  (e.g. `/p/hollow-paperclip/`) instead of a random token tail. This legacy
  unlisted URL shape remains supported. (#10)
- **Advanced publish settings** — a "Publish as a drop" toggle in the admin UI
  mints a short, shareable (guessable) link; the default stayed a longer
  unlisted word-only link. (#11)
- **Docker support** — a single image runs the dashboard *and* every
  publish/deploy command. Ships a Dockerfile, Compose file, and headless CLI
  usage with a scoped `CLOUDFLARE_API_TOKEN`. (#9)
- **Deploy history** — view and remove old whole-site Cloudflare Pages
  deployment snapshots from the admin UI (**Settings → Deploy history**) or the
  terminal: `pagecast pages deployments list|delete|prune`. (#6)
- **Anonymous usage telemetry (originally opt-out)** — reports only the command name,
  pagecast/Node version, and OS/arch; never file contents, paths, published
  URLs, or Cloudflare tokens. Off in CI by default; disable with
  `pagecast telemetry disable`, `PAGECAST_TELEMETRY=0`, or `DO_NOT_TRACK=1`. (#12)

### Fixed

- **Windows compatibility** — spawn `npx` via the shell and accept Windows-style
  paths so publish and deploy work on Windows. (#8)

## 0.1.6

- **Expiring URLs** — edge-enforced link expiry (default 30d, configurable via
  `--expires <7d|12h|never>`), enforced by a generated Cloudflare Pages
  Function. (#5)
