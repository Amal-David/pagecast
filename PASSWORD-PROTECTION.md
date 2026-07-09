# Password Protection

Pagecast can lock any published report behind a password. Protection is opt-in
per report, off by default, and works for both single HTML files and multi-file
reports or folders (Playwright, Lighthouse, `dist/`, and friends). When it is
off, the published site stays 100% static, exactly as before.

## What It Is

A protected report serves a native browser password prompt before any of its
pages or assets load. Unlock it once and the rest of the report opens normally.
Nothing about the report's content changes — only an access gate is added in
front of it.

Use it for finished artifacts you want to share with a known audience but not
expose to anyone with the link.

## How To Use

### From The Admin UI

Each report has a **Password protection** toggle with a password field. Turn the
toggle on, enter a password, and Pagecast redeploys the report's active
snapshots in place — same URL, gate now on. Turn the toggle off to remove it.

### From The Terminal

Publish (or re-publish) a report with protection:

```sh
npx pagecast publish "/absolute/path/report.html" --password "<pw>"
```

This works for any report Pagecast can publish — a single HTML or Markdown file,
or a built static folder's entry file:

```sh
npm run build
npx pagecast publish "$(pwd)/dist/index.html" --password "<pw>"
```

Remove protection from a report you are re-publishing:

```sh
npx pagecast publish "/absolute/path/report.html" --no-password
```

`--password` sets or replaces protection; `--no-password` removes it. If you
pass neither, any existing protection on a reused report is left untouched. On
success the CLI prints a confirmation:

```text
Published: https://<project>.pages.dev/p/<token>/
Password protection: on (visitors must enter the password).
```

## How It Works

Protection is enforced at the edge by a generated Cloudflare Pages Function, not
by anything in the report's own HTML.

- On every deploy, when at least one publication is protected, Pagecast writes
  `functions/_middleware.js` (the gate plus a baked manifest of protected slugs
  and their password hashes) and a `_routes.json` that scopes the Function to
  protected `/p/<slug>/` paths only.
- Unprotected reports are listed in neither file, so they never invoke the
  Function and stay purely static. When no report is protected, both files are
  removed entirely.
- Content is deployed **plain**. The Function gates it at request time with HTTP
  Basic Auth. On a correct password it sets a signed session cookie, so a
  multi-asset page only pays the password-hashing cost on the first request, not
  for every sub-asset.

The password hash is baked into the Function source. A Pages Function's source
is never served as a static asset, so the hash is never downloadable — the
content is never offline-brute-forceable.

No new Cloudflare OAuth scope is needed. Functions deploy under the same
`pages:write` flow Pagecast already uses, so turning protection on requires no
extra setup or permissions.

The plaintext password is never stored. Pagecast keeps only a salted PBKDF2 hash
(`{ salt, hash, iterations }`), persisted server-side in `.pagecast/reports.json`
and baked into the deployed Function. It is never returned by the local API —
the report endpoints expose only a `passwordProtected` boolean.

## Crypto Scheme

| Component | Choice |
| --- | --- |
| Hash | PBKDF2-SHA256 |
| Iterations | 100,000 |
| Salt | 16 bytes, random per report |
| Derived key | 32 bytes |

The publishing side hashes with Node's `node:crypto` (`pbkdf2Sync`). The edge
Function hashes the candidate password with WebCrypto (`crypto.subtle`,
`PBKDF2` / `SHA-256`). Both use the same salt and iteration count, so they
produce the identical hash — cross-runtime parity is asserted in the test suite.

On a correct password the Function issues a session cookie signed with
HMAC-SHA256 using a per-install secret (`authCookieSecret` in
`.pagecast/config.json`). The secret is generated once and stays stable across
redeploys so existing sessions survive a re-sync. The cookie carries an
expiry and is verified in constant time on each request.

### Why 100,000 Iterations

This is deliberately lower than the ~600k you would use for a password hash that
ships in a downloadable blob. Here the hash is never published, so the attacker
can never run an offline crack — key stretching is defense-in-depth, not the
primary boundary. A modest iteration count keeps per-request edge CPU low, which
matters because the Function may run on the first request of every protected
page view.

## Security Model And Caveats

- **Assets are protected too.** The gate sits in front of the whole `/p/<slug>/`
  prefix, so sub-pages, images, JSON, and other assets are all gated, not just
  the entry HTML.
- **Protection is deployment-scoped.** A new protected publish includes the gate
  before its first successful deployment. Changing an existing link takes effect
  only after the replacement deployment succeeds, and multiple Pages targets
  update serially. Cloudflare's immutable URLs for older unprotected deployments
  remain reachable until you prune/delete those deployments.
- **The only attack is online guessing.** Because the hash is never served,
  there is no offline crack — an attacker can only submit guesses to the live
  endpoint, which is slow. You can add a Cloudflare WAF rate-limit rule for
  extra protection. Still, **use a strong password.**
- **No built-in rate limiting or lockout (v1).** Pagecast does not throttle or
  lock out repeated failed attempts itself. Rely on a strong password and,
  optionally, a Cloudflare WAF rule.
- **Basic Auth UX.** Visitors see the browser's native Basic-auth prompt. The
  username is ignored — only the password is checked. There is no clean logout;
  a custom login page is planned polish, not a current feature. If the prompt is
  dismissed, the report shows a simple "This page is password protected" page.
- **Cloudflare Pages required.** A protected site ships a Pages Function, so its
  output is Cloudflare-specific while protection is on. Unprotected reports stay
  portable static files.
- **Secure context is provided.** HTTPS comes from Cloudflare Pages in
  production and from the local `127.0.0.1` published-page preview during
  development, so the signed `Secure` session cookie works in both.

## Operational Notes

- **Re-syncing needs no password.** Auto-sync and manual re-sync only update the
  plain content; the gate is regenerated independently from the stored hash. You
  never need to re-enter the password to push new content.
- **Changing the password.** Toggle protection on again with a new password in
  the UI, or re-run `publish` with a new `--password "<pw>"`. The new hash
  replaces the old one on the next deploy.
- **Removing protection.** Turn the UI toggle off, or publish with
  `--no-password`. Pagecast clears the stored hash and redeploys, dropping the
  Function (and `_routes.json`) when no report remains protected.
