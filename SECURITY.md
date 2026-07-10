# Security

Pagecast is local-first: the admin app runs on your machine, and everything it
publishes goes to **your own** Cloudflare account. There is no Pagecast-hosted
backend in the publish path.

## Reporting a vulnerability

Please report security issues privately via a
[GitHub security advisory](https://github.com/Amal-David/pagecast/security/advisories/new)
rather than a public issue. We aim to acknowledge within 72 hours.

## Local trust boundaries

- **Admin UI + local server** bind to loopback by default. The server rejects
  non-loopback Host headers. Browser mutations also require the admin origin
  and a per-process CSRF token; no-Origin automation mutations require the
  private workspace capability.
- **Container binds** may use a wildcard address only with the explicit
  `PAGECAST_ALLOW_LOOPBACK_PROXY=1` mode used by the packaged Docker setup. The
  host port must still be published on `127.0.0.1`. Arbitrary routable bind
  hosts remain rejected even when that option is present.
- **Report previews** are served from the separate local public origin (normally
  port 4174), not the admin origin. The admin `/preview/...` route redirects to
  that origin, and preview iframes are sandboxed without top-navigation
  permission. `allow-same-origin` remains enabled only on this separate origin
  so report modules, relative assets, storage, and forms can work.
- **CLI and MCP publication mutations** route to a running server through a
  private local capability stored in a `0600` runtime descriptor. With no live
  server, a one-shot process takes the same exclusive workspace lease before
  writing.
- **Chrome extension requests** must come from the stable, allowlisted Pagecast
  extension ID and are limited to the session, status, and local-publish adapter
  routes. Publishing also requires the current admin-session token. An unpacked
  development ID is accepted only through the explicit
  `PAGECAST_EXTENSION_ID_OVERRIDE` environment override.
- **Public API responses** use allowlists. Cookie-signing, sync, admin,
  telemetry, feedback, and Cloudflare tokens are not returned to the browser,
  CLI JSON, or MCP clients.

These controls are a local-process boundary, not remote-user authentication.
The admin server can run user-configured build commands and Cloudflare deploys;
do not expose either local port to a VPN, LAN, public interface, or bare Docker
port mapping.

## Access model for shared links

- A **drop** is short, public, and intentionally easy to share or guess.
- A new **unlisted** URL has a memorable prefix plus 128 bits of opaque
  capability entropy. Anyone with the URL can view it; unlisted is not private
  or authenticated.
- A **password-protected** publication is gated at the Cloudflare edge by a
  generated Pages Function after its protected deployment succeeds. New
  protected links include the gate in their first successful deployment;
  changes to existing links take effect target by target. Older immutable
  deployment URLs are not retroactively protected. Expiry is also enforced at
  the edge; on the production site, expired links return `410` and revoked links
  return `404` after the cleanup deployment. Older immutable deployment URLs
  retain the content and gate state they originally shipped with until pruned.
- Existing word-only URLs remain valid and are not silently rotated. They do
  not retroactively gain the entropy of the new URL shape; rotate/re-publish
  one if that distinction matters.
- Path-backed reports can stage non-hidden sibling files from the report's
  folder. Publish from a clean folder and keep source, credentials, and other
  private files outside the published tree.

The Pages root publishes no report index. For recipient authentication, use
Pagecast password protection or add your organization's access layer/custom
domain controls. v0.5 does not introduce Cloudflare Access/SSO.

## Cloudflare project ownership

Managed publication state is scoped by Cloudflare account ID plus project name;
snapshots, redirects, and password/expiry manifests are filtered to that target.
Pagecast writes an ownership marker and requires explicit adoption before it
manages an unrelated existing project.

Legacy links without a recorded target remain readable, but sync, rename,
expiry changes, and revoke are disabled until the original account/project is
selected and **Attach selected project** is confirmed. Do not attach a link to a
different project merely because its hostname looks similar.

`pagecast pages deploy` is an explicit whole-site deploy. It does not change the
managed `/p/...` target, but it still replaces the named project's contents. Use
a separate project unless that replacement is intentional.

## Cloudflare permissions

- Publishing uses scoped Wrangler OAuth: `account:read`, `user:read`,
  `pages:write`.
- Enabling reactions/analytics requests an **elevated** grant adding
  `workers_scripts:write` and `workers_kv:write` to deploy the feedback Worker
  and KV. This is requested only when the feature is enabled.
- You can revoke Pagecast's access with `npx --yes wrangler@4.86.0 logout` or
  from the Cloudflare dashboard. Deployed Worker/KV resources can be removed
  there too.

## Supply chain and local execution

- The package has **no runtime npm dependencies**; the React admin UI is
  prebuilt into `public/`.
- Native and Docker publishing share the exact Wrangler `4.86.0` pin from
  `src/platform.js`. `PAGECAST_WRANGLER_VERSION_OVERRIDE` accepts only an exact
  version and is intended for tests or deliberate local compatibility work.
- State/config writes use private directories/files and atomic replacement.
  Cloudflare and local state are not one atomic system: Pagecast journals intent
  before remote side effects, records incomplete publish/sync/protection/rename
  or cleanup work, and exposes a type-safe recovery path instead of claiming the
  operation completed everywhere.
- Agent hooks pass selected file paths through reusable opaque, shell-safe
  transport tokens; paths are not interpolated into executable shell snippets.
  These encodings are not secrets or access-control tokens.
- Source-folder build commands are intentionally executable user input. Pagecast
  selects `sh -lc` on POSIX or `%ComSpec% /d /s /c` on Windows, but it cannot
  make arbitrary command syntax portable or safe for an untrusted repository.
- Verify package contents with `npm pack --dry-run --json`.
