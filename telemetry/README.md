# Pagecast telemetry ingestion

This directory holds the server-side validation logic for anonymous usage
telemetry, plus an optional standalone-Worker deployment. End users control
whether anything is sent at all. Fresh installs enable telemetry by
default; existing persisted choices remain compatible. `PAGECAST_TELEMETRY=0`
and `DO_NOT_TRACK=1` disable delivery, while an explicit
`PAGECAST_TELEMETRY=1` enables it outside a `DO_NOT_TRACK` environment. See the
repository `PRIVACY.md` for exactly what is and isn't collected.

## Where events actually go

The live endpoint the CLI uses is **`https://pagecasthq.pages.dev/api/v1/event`**,
a Cloudflare Pages Function on the pagecast site (source:
`functions/api/v1/event.js` in the **pagecast-landing** repo). It writes to a
Workers Analytics Engine dataset (`pagecast_usage`) via the `PAGECAST_TELEMETRY`
binding. `DEFAULT_TELEMETRY_ENDPOINT` in `src/telemetry.js` points there.

`worker.js` in this directory is the same validation logic as a standalone
Cloudflare Worker. Its pure helpers are what the test suite exercises
(`test/telemetry.test.js`), and it doubles as a self-host option (below). Keep it
in sync with the Pages Function.

## What it stores

Per event (all anonymous, all re-validated server-side against fixed allowlists):

- `command` / `subcommand` — which CLI command ran (allowlisted keywords only)
- `outcome` — `started` / `success` / `error`
- `version` — pagecast version
- `os` / `arch` / `node` — coarse platform info
- `anonId` — a random opaque 32-char install id (no PII, no account linkage)

The install id is created lazily only after telemetry is enabled and an event is
about to be sent.

Never stored: file contents, file paths, published URLs, Cloudflare tokens or
account IDs, IP addresses.

## Self-host as a standalone Worker (optional)

```bash
cd telemetry
npx --yes wrangler@4.86.0 deploy
```

Requires Analytics Engine enabled on the account (Dashboard → Workers & Pages →
Analytics Engine). The dataset `pagecast_usage` is created on first write. Point
`DEFAULT_TELEMETRY_ENDPOINT` at the deployed `<url>/api/v1/event` if you use this
path instead of the Pages Function.

## Query

```bash
# Counts by command (Analytics Engine SQL API)
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -d "SELECT blob1 AS command, count() AS n FROM pagecast_usage GROUP BY command ORDER BY n DESC"
```
