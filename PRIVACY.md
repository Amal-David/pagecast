# Privacy

Pagecast is local-first. Managed publication state, deploy history, analytics
configuration, and the operation journal live under `~/.pagecast/home/`.
Workspace `.pagecast/` directories retain workspace/source identity and Home
mappings. An explicit `--data-dir` creates an isolated profile. Publishing goes
directly to **your own** Cloudflare account. Cloudflare Pages is the default.
The optional Pagecast Worker is also deployed into your account; Pagecast has
no maintainer-hosted backend in either publish path.

Anonymous CLI usage telemetry is the only data Pagecast may send to a
maintainer-operated endpoint. A genuinely fresh install enables it
by default and shows a one-time disclosure before sending an event.

## Anonymous usage telemetry

### Consent and compatibility

- **Fresh install:** telemetry is enabled by default. Run
  `pagecast telemetry disable` to opt out at any time.
- **Upgrade:** an existing saved enable/disable choice is preserved. A config
  with no telemetry field resolves to the default enabled behavior.
- **Environment:** `DO_NOT_TRACK=1` always disables telemetry. An explicit
  `PAGECAST_TELEMETRY=1` or `PAGECAST_TELEMETRY=0` overrides the saved choice;
  CI is disabled unless explicitly enabled.

Check the effective state and its deciding reason at any time:

```sh
pagecast telemetry status
pagecast telemetry enable
pagecast telemetry disable
```

### What is collected when enabled

| Field | Example | Why |
| --- | --- | --- |
| `command` | `publish`, `pages`, `serve` | Which feature is used |
| `subcommand` | `deploy`, `status` (allowlisted only) | Which sub-feature is used |
| `outcome` | `started` | Reserved for success/error signal |
| `version` | `0.7.0` | Which release is in the field |
| `os`/`arch` | `darwin` / `arm64` | Which platforms to support |
| `node` | `v22.22.3` | Which Node versions to support |
| `anonId` | random 32-character hex | Coarse distinct-install counting |

`anonId` is generated lazily only when telemetry is enabled and an event is
about to be sent. It is random and is not tied to a name, email, Cloudflare
account, or other user identity.

### What is never collected

- File contents, file names, or file paths, including a `publish <path>` argument
- Published URLs, origins, tokens, slugs, passwords, or expiry values
- Cloudflare account IDs, account names, API/OAuth tokens, or project names
- Local admin/CSRF/runtime capabilities, config secrets, or operation-journal data
- IP addresses or other personal information stored in maintainer telemetry

The command classifier uses fixed allowlists, so positional arguments never
enter an event. The receiving Worker independently validates the same bounded
schema.

### Where it goes

Events are sent to
`https://pagecasthq.pages.dev/api/v1/event`, a Cloudflare Pages Function operated
by the maintainer, and stored in aggregate through Workers Analytics Engine.
Pagecast does not use a third-party analytics provider for these events.

Network infrastructure may process connection metadata in the ordinary course
of delivering an HTTPS request, but Pagecast does not put IP addresses into the
event or store per-visitor records in its telemetry dataset.

## Page access analytics

Page access analytics is separate from maintainer telemetry and is opt-in. The
existing Pages workflow can deploy its Activity Worker and D1 database. A
Pagecast Worker stores its own V2 analytics in its declared D1 database. The two
datasets are separate. The reactions bar remains optional.

The existing Pages Activity Worker stores:

- Immutable Pagecast publication ID and access time
- A stable anonymous visitor ID
- Country, region/city when Cloudflare provides them
- ASN/organization, coarse device class, and referrer hostname

Pagecast Worker V2 stores the immutable publication/version identity, event
type or allowlisted reaction, access time, country code, coarse device class,
and referrer hostname. It does not store region, city, ASN, or organization.

The Worker may read `CF-Connecting-IP` while handling the request. It immediately
HMACs that value with a random per-Home secret and discards the raw address. A
full IP address is never written to D1, KV, Pagecast logs, local APIs, or browser
payloads. Referrers are reduced to hostnames; complete referrer URLs are not
stored. Analytics uses no cookies.

Detailed access events and unique-view rows are retained for 30 days. Aggregate
view totals remain after detailed cleanup. Worker V2 defaults to 1,000 accepted
events per owner per UTC day and 2,000 globally per UTC day. Existing aggregate
KV totals in the Pages Activity path are migrated without inventing historical
visitor details. Renaming a URL does not lose history because events use
immutable publication IDs rather than slugs.

Analytics is visibility, not access prevention. An unlisted link can be opened
by anyone who has its URL. Worker publications can use password or allowlist
policies and scoped grants. Optional Cloudflare Access identity is accepted only
after a valid signed JWT passes the configured issuer, audience, and JWKS checks.

## Worker control and collaboration data

The optional Worker stores owner-scoped publication metadata, immutable-version
manifests, access policies, grants, organizations, actors, memberships,
comments, reviews, audit events, webhook state, and job state in D1. Immutable
publication files and generated artifacts live in R2.

Bearer tokens, access grants, invitations, and webhook credentials are stored
as digests or derived secrets. Plaintext credentials are returned only by the
creation or rotation response that produced them. Password hashes are never
returned by control reads. The local dashboard stores its Worker bearer token
in a separate private `0600` file and does not expose it to browser state.

Webhook delivery sends the configured event payload to the HTTPS destination
chosen by the operator. Destinations reject embedded credentials, IP literals,
loopback/local hosts, and non-default ports. The operator is responsible for the
privacy policy and retention of the receiving system.

Terminal job, attempt, webhook-delivery, dead-letter, and generated-artifact
records use 30-day retention. Deleted inactive version files are removed after
their recorded retention time. Audit events are append-only and do not have an
automatic expiry in this release. D1 backups and the matching R2 objects remain
under the operator's Cloudflare account and retention controls.

## Other network activity

- Report publishing, project discovery, and deployment management communicate
  with Cloudflare through Wrangler or the Cloudflare API for the account you
  selected.
- Published report content lives on the actual Cloudflare production origin
  returned by deployment, under your account and control.
- A configured Worker webhook sends signed event payloads to the HTTPS endpoint
  selected by the operator.
- Optional screenshot, PDF, and accessibility jobs send the Worker publication
  URL to the configured Cloudflare Browser binding. That provider is not active
  unless the operator adds the binding and `PUBLIC_ORIGIN`.
- The optional Chrome extension sends the selected local file path only to the
  Pagecast server on your loopback interface. The extension has no telemetry and
  does not send browsing data or file paths to the maintainer. See
  [extension/store/PRIVACY.md](extension/store/PRIVACY.md).

## Questions

Open an issue on the [Pagecast repository](https://github.com/Amal-David/pagecast)
for any privacy question.
