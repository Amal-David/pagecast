# Privacy

Pagecast is local-first. Reports, config, deploy history, and the local operation
journal live under `.pagecast/` in the working directory. Publishing goes
directly to **your own** Cloudflare account; Pagecast has no hosted backend in
that path.

Anonymous CLI usage telemetry is the only data Pagecast may send to a
maintainer-operated endpoint. A genuinely fresh v0.5 install sends nothing
until you explicitly consent.

## Anonymous usage telemetry

### Consent and compatibility

- **Fresh install:** consent is pending and telemetry is disabled. Run
  `pagecast telemetry enable` to opt in.
- **Upgrade:** an existing saved enable/disable choice is preserved. A pre-v0.5
  config with no telemetry field keeps the v0.4 enabled behavior rather than
  silently changing an existing workspace's setting.
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
| `version` | `0.5.0` | Which release is in the field |
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
- IP addresses or other personal information stored by Pagecast

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
