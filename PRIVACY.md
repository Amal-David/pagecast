# Privacy

Pagecast is local-first. Your reports, config, and deploy history live in
`.pagecast/` in your working directory, and publishing goes directly to **your
own** Cloudflare account. Pagecast has no server of its own in that path.

The one thing Pagecast sends to the maintainer is anonymous usage telemetry,
described below. It is optional and easy to turn off.

## Anonymous usage telemetry

To understand how Pagecast is actually used (and what to improve), the CLI sends a
small, anonymous event when you run a command.

### What is collected

| Field       | Example                              | Why |
|-------------|--------------------------------------|-----|
| `command`   | `publish`, `pages`, `serve`          | Which feature is used |
| `subcommand`| `deploy`, `status` (allowlisted only)| Which sub-feature is used |
| `outcome`   | `started`                            | Reserved for success/error signal |
| `version`   | `0.3.0`                              | Which release is in the field |
| `os`/`arch` | `darwin` / `arm64`                   | Which platforms to support |
| `node`      | `v22.22.3`                           | Which Node versions to support |
| `anonId`    | random 32-char hex                   | Coarse "distinct installs" counting |

`anonId` is a random opaque identifier generated once on your machine. It is not
tied to your name, email, Cloudflare account, IP, or anything else.

### What is never collected

- File contents, file names, or file paths (e.g. a `publish <path>` argument)
- Published URLs, tokens, slugs, or passwords
- Cloudflare account IDs, account names, or API tokens
- IP addresses or any personal information

The command classifier uses fixed allowlists, so positional arguments (like the
path you publish) are never included in an event. The receiving Worker
independently re-validates every field against the same allowlists.

### Where it goes

Events are sent to the Pagecast site's own endpoint
(`https://pagecasthq.pages.dev/api/v1/event`, a Cloudflare Pages Function operated
by the maintainer) and stored in aggregate via Workers Analytics Engine. Nothing
is shared with any third-party analytics provider.

### How to opt out

Telemetry is on by default. A one-time notice prints on first run. Turn it off at
any time with any of these:

```sh
pagecast telemetry disable        # persisted in .pagecast/config.json
pagecast telemetry status         # check the current state and why
export PAGECAST_TELEMETRY=0       # environment override
export DO_NOT_TRACK=1             # cross-tool standard, also honored
```

Telemetry is automatically disabled in CI environments, unless explicitly
re-enabled with `PAGECAST_TELEMETRY=1`.

## Questions

Open an issue on the [Pagecast repository](https://github.com/Amal-David/pagecast)
for any privacy question.
