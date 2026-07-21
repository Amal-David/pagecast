# Privacy

Pagecast is local-first. Managed publication state, deploy history, analytics
configuration, and the operation journal live under `~/.pagecast/home/`.
Workspace `.pagecast/` directories retain workspace/source identity and Home
mappings. An explicit `--data-dir` creates an isolated profile. Publishing goes
directly to **your own** Cloudflare account; Pagecast has no hosted backend in
that path.

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
| `version` | `0.6.1` | Which release is in the field |
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

Page access analytics is separate from maintainer telemetry and is opt-in. When
enabled, Pagecast deploys a Worker and D1 database into your Cloudflare account.
The reactions bar is a separate option and may remain disabled.

For each page access, the Worker stores:

- Immutable Pagecast publication ID and access time
- A stable anonymous visitor ID
- Country, region/city when Cloudflare provides them
- ASN/organization, coarse device class, and referrer hostname

The Worker may read `CF-Connecting-IP` while handling the request. It immediately
HMACs that value with a random per-Home secret and discards the raw address. A
full IP address is never written to D1, KV, Pagecast logs, local APIs, or browser
payloads. Referrers are reduced to hostnames; complete referrer URLs are not
stored. Analytics uses no cookies.

Detailed access events are retained for 30 days. Aggregate view totals remain
after detailed cleanup. Existing aggregate KV totals are migrated without
inventing historical visitor details; detailed history begins only after the
upgrade. Renaming a URL does not lose history because events use immutable
publication IDs rather than slugs.

Analytics is audit visibility, not visitor identity or access prevention. An
unlisted link can be opened by anyone who has its URL. Pagecast password
protection is the current access-control option; named Cloudflare Access identity
is not part of this release.

## Other network activity

- Report publishing, project discovery, and deployment management communicate
  with Cloudflare through Wrangler or the Cloudflare API for the account you
  selected.
- Published report content lives on the actual Cloudflare production origin
  returned by deployment, under your account and control.
- The optional Chrome extension sends the selected local file path only to the
  Pagecast server on your loopback interface. The extension has no telemetry and
  does not send browsing data or file paths to the maintainer. See
  [extension/store/PRIVACY.md](extension/store/PRIVACY.md).

## Questions

Open an issue on the [Pagecast repository](https://github.com/Amal-David/pagecast)
for any privacy question.
