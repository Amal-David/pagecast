# Pagecast Worker

Pagecast Worker is the optional stateful backend for Pagecast. Cloudflare Pages
remains the default. Deploy this Worker when you need immutable versions,
rollback, allowlists and grants, team review, private analytics, audit,
webhooks, background jobs, or remote MCP.

All publication responses send `X-Robots-Tag: noindex, nofollow, noarchive`,
including public links, assets, redirects, and authentication responses on
the Worker and content origins. Search exclusion is advisory; use password
or allowlist access for confidential content. Deploy the updated Worker to
apply this policy to existing publications. Search results may persist until
crawlers revisit them; do not block that crawl with `robots.txt`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Amal-David/pagecast/tree/main/worker)

Cloudflare documents the button and supported resources in
[Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

The button copies this directory as a standalone repository root. It works only
from a public GitHub or GitLab repository. The deployer must review the generated
resources and supply the secrets below; the button does not invent secret
values. Cloudflare provisions the declared D1 database, R2 bucket, Durable
Object, Queue, Cron trigger, and static assets during setup.

## Required secrets

Generate five different 32-byte values. Never reuse one value for another
purpose.

```sh
openssl rand -hex 32  # ADMIN_TOKEN
openssl rand -hex 32  # TOKEN_HASH_KEY
openssl rand -hex 32  # ANALYTICS_HMAC_KEY
openssl rand -hex 32  # COOKIE_SIGNING_KEY
openssl rand -hex 32  # WEBHOOK_SIGNING_KEY
```

| Secret | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Bootstrap token administration. Do not use it as a normal publishing token. |
| `TOKEN_HASH_KEY` | HMAC key for API, grant, and invitation credentials stored as digests. |
| `ANALYTICS_HMAC_KEY` | HMAC key for short-lived anonymous visitor identifiers. |
| `COOKIE_SIGNING_KEY` | Signs password-session cookies and password-throttle fingerprints. |
| `WEBHOOK_SIGNING_KEY` | Derives per-webhook signing secrets. |

For manual deployment, set each value with Wrangler:

```sh
npx wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
npx wrangler secret put TOKEN_HASH_KEY --config wrangler.jsonc
npx wrangler secret put ANALYTICS_HMAC_KEY --config wrangler.jsonc
npx wrangler secret put COOKIE_SIGNING_KEY --config wrangler.jsonc
npx wrangler secret put WEBHOOK_SIGNING_KEY --config wrangler.jsonc
```

Secret rotation is an operator procedure. Rotating a signing or hashing key
invalidates credentials or sessions derived from the old key. Create new
credentials and plan the cutover before replacing a production value.

## Deploy

### Deploy button

1. Open the deploy button and authorize Cloudflare to copy the `worker/`
   template.
2. Enter the five independent secrets.
3. Review the D1, R2, Durable Object, Queue, Cron, and assets resources.
4. Run the proposed deploy command. The package deploy script applies remote D1
   migrations before deploying the Worker.
5. Record the final `https://<name>.<account>.workers.dev` origin.

The button becomes usable for a Pagecast release only after this directory is
present on the public default branch. A successful local dry run does not prove
that a live deployment, custom domain, Access policy, or paid provider is active.

### Manual deployment

```sh
npm ci
npm run check
npm run deploy:dry-run
npm run deploy
```

`npm run deploy` applies `migrations/` to the remote `DB` binding, then runs
`wrangler deploy`. Review every new migration before production. D1 migrations
are forward-only; back up production data before a schema or destructive
retention change.

## Create a scoped Pagecast token

Choose an owner ID containing letters, numbers, `_`, or `-`. Use the bootstrap
secret once to create a normal expiring token. The token value is returned only
in the creation response.

```sh
curl --fail-with-body https://YOUR-WORKER.example/v1/owners/YOUR_OWNER/tokens \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: bootstrap-dashboard-1" \
  --data '{
    "label": "Pagecast local dashboard",
    "expiresAt": "2027-01-01T00:00:00Z",
    "scopes": [
      "status:read",
      "publications:read",
      "publications:write",
      "collaboration:read",
      "collaboration:write",
      "collaboration:admin",
      "reviews:write",
      "analytics:read",
      "audit:read",
      "webhooks:read",
      "webhooks:write",
      "jobs:read",
      "jobs:write"
    ]
  }'
```

Use a unique idempotency key for each intended token. Repeating the same request
with the same key returns the same token; changing the request under that key is
rejected. Store the returned `pcv2_...` token in a password manager.

Connect local Pagecast:

```sh
npx pagecast workers connect \
  --origin https://YOUR-WORKER.example \
  --owner YOUR_OWNER \
  --token 'pcv2_...' \
  --json

npx pagecast workers status --json
```

Pagecast writes Worker credentials to a separate `0600` file. The browser sends
the token to the local server only during connection and clears the form after
the request. The bootstrap secret, token digests, password hashes, R2 keys,
visitor identifiers, and local capabilities are not returned to the dashboard.

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace every value in .dev.vars with an independent local secret.
npm run db:migrate:local
npx wrangler dev --config wrangler.jsonc
```

Run checks and a production-shape dry run before pushing:

```sh
npm run check
npm run deploy:dry-run
```

The package is isolated from the parent Pagecast repository. Its own lockfile,
Wrangler configuration, migrations, tests, source, and assets must remain
sufficient when Cloudflare copies this directory.

## Storage and delivery model

- D1 stores owners, scoped tokens, publications, active-version pointers,
  access policies, grants, collaboration records, analytics, audit, webhook
  delivery state, job state, and idempotency receipts.
- R2 stores immutable publication files, canonical manifests, and generated job
  artifacts. Public responses are resolved through D1; object keys never enter
  public or dashboard responses.
- A Durable Object serializes each owner's mutations. D1 uniqueness constraints
  and stored idempotency receipts settle cross-owner slug races.
- Queue consumers process webhook delivery, cleanup, expiry, inspection, and
  rendering jobs. Cron runs every 15 minutes to repair lost enqueue attempts,
  recover expired leases, enforce retention, and enqueue due work.
- Static assets provide the small public runtime used by the Worker.

Uploads accept at most 25 files, 16 MiB per file, and 256 MiB total. Upload
sessions expire after 24 hours. The client hashes and uploads at most four files
at once, checkpoints progress, applies access policy, and activates last. Each
file upload has a five-minute request deadline; control requests retain the
30-second default.

Public delivery supports `GET`, `HEAD`, byte ranges, ETags, MIME types, content
negotiation, social metadata, cache policy, public/unlisted/password/allowlist
access, grants, and expiry. Unlisted URLs contain a memorable prefix plus 128
bits of random capability entropy. They are bearer links, not user identity.

The `allowlist` mode restricts delivery to a sharing credential or a session
created by redeeming it. It does not look up recipient email addresses.
Password links open a password form; restricted links open a credential form.
Recipients can redeem a credential at `/p/<slug>/_auth/grant#<credential>`.
The fragment is removed before form submission. Sessions remain scoped to that
publication's isolated hostname; revoking a grant invalidates its sessions.

## Analytics, audit, and retention

The Worker HMACs the transient connection address before an analytics event is
constructed. It keeps only coarse country, referrer hostname, and device class.
Raw addresses, full referrer URLs, and browser fingerprints are not stored.

Detailed events and unique-view rows expire after 30 days; aggregates remain.
The default ingest limits are 1,000 accepted events per owner per UTC day and
2,000 globally per UTC day. Override them only with bounded numeric values in
`ANALYTICS_DAILY_EVENT_LIMIT` and `ANALYTICS_GLOBAL_DAILY_EVENT_LIMIT`.

Completed/dead-lettered webhook records, terminal jobs, attempts, dead letters,
and artifacts use 30-day retention. Deleted inactive version files are purged
after their recorded retention time. Audit events are append-only and paginated;
this release does not automatically expire them.

## Webhooks and jobs

Webhook destinations must be HTTPS hostnames. Loopback, IP literals, embedded
credentials, and non-default ports are rejected. Signatures use a derived secret
returned only when a webhook is created or rotated. Delivery retries are bounded
and terminal failures become dead letters.

`link_check` and `index` inspect the selected immutable version inside R2 and do
not crawl arbitrary external URLs. `screenshot`, `pdf`, and
`accessibility_check` need the optional `BROWSER` binding and `PUBLIC_ORIGIN`.
Without that provider, those jobs fail visibly with `unsupported_provider`; a
provider error during the job fails with `provider_failed`. Pagecast does not
claim that a paid Browser service is active.

## Custom domains and isolated protected content

Follow Cloudflare's [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
guide and add the domain in **Cloudflare Dashboard → Workers & Pages → Pagecast
→ Settings → Domains & Routes**. After DNS and certificates are active, set:

```json
{
  "vars": {
    "ENVIRONMENT": "production",
    "PUBLIC_ORIGIN": "https://reports.example.com",
    "CONTENT_ORIGIN": "https://content.reports.example.com"
  }
}
```

The one-click deployment and a single `PUBLIC_ORIGIN` remain sufficient for
public and unlisted links. Add `CONTENT_ORIGIN` only when the deployment also
needs password or grant-protected delivery.

`CONTENT_ORIGIN` is required before Pagecast serves password-protected or
grant-protected publications. It must be an HTTPS origin with no path, query,
fragment, credentials, or port. Configure proxied wildcard DNS, a Worker route
such as `https://*.content.reports.example.com/*`, and TLS coverage for
`*.content.reports.example.com`; Pagecast then serves each publication from
`<publication-id>.content.reports.example.com`. The browser sessions are
host-only, and Pagecast redirects a shared-host URL to that exact publication
host before sending any bytes. This prevents arbitrary HTML from one
publication reading protected content from another publication on the same
origin. Cloudflare Custom Domains require exact hostnames, so this setup uses
[Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
and [wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).
Ensure the certificate covers the full content-host depth; a certificate for
`*.example.com` does not cover `publication.content.reports.example.com`.

Without `CONTENT_ORIGIN`, public and unlisted publications can still use the
shared Worker hostname, but password and grant delivery fails closed with 503.
Set the wildcard routing, TLS, and `CONTENT_ORIGIN` before enabling either protected
access mode.

Redeploy, verify `/health` and authenticated `/v1/status`, then reconnect local
Pagecast to the custom origin. Adding the domain and changing DNS are operator
actions; this repository does not perform them.

## Cloudflare Access identity

Bearer tokens remain required for Worker control and MCP requests. If an
operator already routes requests through Cloudflare Access, Pagecast can verify
the injected `Cf-Access-Jwt-Assertion` for collaboration identity. Set all three
values together:

```text
ACCESS_JWT_ISSUER=https://YOUR_TEAM.cloudflareaccess.com
ACCESS_JWKS_URL=https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/certs
ACCESS_JWT_AUDIENCE=YOUR_APPLICATION_AUD
```

The issuer and JWKS URL must use HTTPS and the same origin. The JWT must be an
unexpired RS256 token with the configured issuer and audience. The local
Pagecast client does not create Cloudflare Access service-token headers, so an
Access policy that blocks `/v1/*` also needs an operator-provided authentication
route for that client. Configuring Access in the dashboard remains an operator
action.

## Remote MCP

The Worker exposes stateless Streamable HTTP MCP at `/mcp`. Use an expiring
`pcv2_...` token; non-expiring and bootstrap tokens are rejected. Configure
strict request hostnames when using a custom domain:

```text
MCP_ALLOWED_HOSTNAMES=reports.example.com
MCP_ALLOWED_ORIGIN_HOSTNAMES=your-agent.example
```

Requests require `POST`, `Authorization: Bearer ...`, a matching Host, and a
matching HTTPS Origin when one is present. The MCP server maps 56 explicit tools
to the same owner-scoped services used by the dashboard. Destructive tools require
`confirm: true`. One-time grant, invitation, webhook, and token credentials are
returned only by the mutation that creates or rotates them. MCP cannot read
local Pagecast files or invoke local builds.

## Backups and recovery

Before migrations or a production cutover:

```sh
npx wrangler d1 export DB --remote --output pagecast-backup.sql --config wrangler.jsonc
```

Back up the R2 bucket separately through Cloudflare's R2 tools or S3-compatible
API. A D1 export without the matching R2 objects cannot restore publication
content.

For recovery:

1. Keep the existing Pages URL live while evaluating Worker delivery.
2. Check D1 migration state and `/v1/status` before retrying a failed publish.
3. Resume the local journaled operation; do not start a second unrelated upload.
4. Roll back by activating an earlier complete Worker version.
5. If Worker delivery must be removed, revoke the Worker publication. The Pages
   publication remains independent unless an operator explicitly cuts it over.

Queue and Cron repair are idempotent and lease-based. An unavailable Queue may
delay work, but the next scheduled repair can enqueue eligible records again.
