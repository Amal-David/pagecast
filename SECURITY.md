# Security

Pagecast is local-first: the admin app runs on your machine, and everything it
publishes goes to **your own** Cloudflare account — there is no Pagecast-hosted
backend that stores your content or your data.

## Reporting a vulnerability

Please report security issues privately via a
[GitHub security advisory](https://github.com/Amal-David/pagecast/security/advisories/new)
rather than a public issue. We aim to acknowledge within 72 hours.

## What runs where

- **Admin UI + local server** bind to `127.0.0.1` (loopback only). They are not
  reachable from your network. State-changing admin routes also enforce a
  loopback `Host` header to block DNS-rebinding from a malicious web page.
- **Published pages** live on your Cloudflare Pages project (`*.pages.dev`).
- **Reactions + analytics** (optional) run in a Cloudflare Worker + KV namespace
  that Pagecast deploys into *your* account. Analytics are cookieless and
  aggregate-only: country (from Cloudflare's edge), referrer host, and device
  class. No IP addresses, no per-visitor records, no PII are stored.

## Access model for shared links

- Published links are **public but unguessable**: `/p/<token>/`, where the token
  carries 128 bits of entropy. Anyone with the link can view the page; there is
  currently **no password, SSO, or expiry** (private/expiring links are on the
  roadmap). Treat a published link like a secret URL, and **revoke** anything
  sensitive from the app.
- Path-backed reports stage non-hidden sibling files from the report's folder, so
  anything in that folder can become reachable if referenced. Publish from a
  clean folder.

## Cloudflare permissions

- Publishing uses scoped Wrangler OAuth: `account:read`, `user:read`,
  `pages:write`.
- Enabling reactions/analytics requests an **elevated** grant adding
  `workers_scripts:write` and `workers_kv:write` (to deploy the feedback Worker +
  KV). This is requested only when you turn the feature on, not at first connect.
- You can revoke Pagecast's access anytime with `npx wrangler logout` or from the
  Cloudflare dashboard. The deployed Worker/KV can be removed from your dashboard.

## Supply chain

- The package has **no runtime npm dependencies**; the React admin UI is prebuilt
  into `public/`.
- Pagecast shells out to Wrangler (Cloudflare's official CLI) for publishing.
- Verify what you install: `npm pack --dry-run` lists the exact files shipped.

## Hardening roadmap

Private/password/expiring links, a `feedback destroy` teardown command, scoped
API-token auth as an alternative to broad OAuth, and pinned-Wrangler/npm
provenance are tracked improvements.
