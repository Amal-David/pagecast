# Security

Pagecast is local-first: the admin app runs on your machine, and everything it
publishes goes to **your own** Cloudflare account. Cloudflare Pages is the
default. The optional Pagecast Worker is also deployed into your account; it is
not a maintainer-hosted backend.

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
- **Worker credentials** are stored in a separate private `0600` file. The
  dashboard receives only the configured origin, owner, bounded health data,
  capabilities, and binding readiness. It never receives the bootstrap secret,
  bearer token, token digest, password hash, R2 object key, local capability,
  or raw visitor identifier.

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
- A **Worker allowlist** requires a scoped sharing credential, redeemable for a
  browser session. It is not an email-address allowlist. Password sessions are signed and versioned; changing policy or
  password invalidates older sessions. Failed password attempts use durable,
  HMAC-derived throttling keys.
- Existing word-only URLs remain valid and are not silently rotated. They do
  not retroactively gain the entropy of the new URL shape; rotate/re-publish
  one if that distinction matters.
- Default Pages path publishing can stage non-hidden sibling files from the
  report's folder. Publish from a clean folder and keep credentials and other
  private files outside that tree. Worker file publishing stages only the
  selected entry; Worker folder publishing uses the selected public tree.

The Pages and Worker roots publish no report index. For recipient identity, the
Worker can verify an Access JWT only when all issuer, audience, and JWKS
settings are configured and the signature validates. A bearer token is still
required for control and MCP requests. The local client does not create
Cloudflare Access service-token headers, so protecting `/v1/*` requires an
operator-provided route for that client.

## Worker control plane

Executable Worker publications use separate publication hostnames when
`CONTENT_ORIGIN` is configured. Protected content is unavailable without that
configuration. Shared-host links redirect before content or session cookies are
sent; sessions use host-only `__Host-` cookies on the publication hostname.
All publication paths enforce the matching hostname, including asset and login
requests. An operator must configure wildcard DNS, Worker routing, and TLS.

- The bootstrap `ADMIN_TOKEN` can create the first owner-scoped token. Do not
  enter it into the local dashboard or use it for routine publishing.
- Normal credentials use a `pcv2_<id>_<secret>` form. D1 stores only the HMAC
  digest. Tokens have explicit scopes, owner identity, optional actor identity,
  expiry, last-use time, and revocation state.
- Mutations require bounded request bodies and an idempotency key. Owner
  mutations are serialized by a Durable Object and committed with D1 receipts.
- Public, unlisted, password, and allowlist delivery resolves an active
  immutable version through D1, then streams the exact R2 object. Public
  responses do not reveal R2 keys.
- Upload paths reject hidden, traversal, malformed, and over-limit entries.
  Limits are 25 files, 16 MiB per file, 256 MiB total, and 256 UTF-8 bytes per
  normalized path.
- Webhook destinations require HTTPS DNS hostnames and reject credentials,
  IP literals, loopback/local names, and non-default ports. Webhook signatures
  use a per-subscription derived secret returned only on create or rotation.
- Remote MCP accepts only `POST`, an expiring scoped token, and a configured
  Host/Origin boundary. Destructive tools require explicit confirmation. MCP
  never receives local paths or local build authority.

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
- Deploying Pagecast Worker provisions D1, R2, a Durable Object, Queue, Cron,
  and static assets in the operator's account. The deploy button and manual
  Wrangler flow require the operator to review those resources and provide five
  independent secrets. Custom domains, Access applications, Browser bindings,
  and Pages cutover are not performed by this repository.

## Supply chain and local execution

- The root package has **no runtime npm dependencies**; the React admin UI is
  prebuilt into `public/`. The standalone `worker/` package has its own pinned
  runtime dependencies and lockfile because Cloudflare deploys it separately.
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
- Worker D1 migrations are forward-only. Back up D1 and the matching R2 bucket
  before production migrations or retention changes. A D1 export alone cannot
  restore immutable publication content.
