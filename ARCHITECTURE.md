# Pagecast Architecture

This document records the invariants that new Pagecast work must preserve. It
also explains where earlier implementation directions were useful locally but
became unsafe when later features composed with them.

## Product boundary

Pagecast turns local static content into Cloudflare Pages links or versioned
Pagecast Worker publications. The privileged dashboard remains a
single-operator local service. The optional Worker is a separately deployed,
owner-scoped control and delivery plane; it does not make the local admin server
remote. Published output stays static while the local dashboard may read files,
run user-configured build commands, and invoke Wrangler.

Consequences:

- The admin listener is loopback-only. The container's wildcard listener is an
  explicit loopback-proxy exception and its host ports must remain mapped to
  `127.0.0.1`.
- Previewed author HTML is untrusted and is served by the separate public
  origin, never the privileged admin origin.
- An unlisted URL is a bearer capability, not an authentication mechanism.
  Password protection is the access-control feature; a short/custom word-only
  URL is an intentionally public drop.
- A direct whole-site deploy and Pagecast's managed `/p/...` publication site
  keep separate local staging and selection state. They may target the same
  remote project only through an explicit direct-deploy choice, which replaces
  that project's contents.
- Pages remains the default backend. Selecting or migrating to Workers is an
  explicit per-publication decision, and migration leaves the Pages publication
  available as an independent recovery path.

## Core invariants

### One Home, one writer

The user-level `~/.pagecast/home/` owns the managed Cloudflare target,
publication registry, analytics configuration, operation journal, and exclusive
lease. Workspace `.pagecast/` state contains only workspace/source identity and
Home mappings. CLI, extension, goal, and MCP mutations route through the Home
owner's authenticated local command service. Without a live owner, a one-shot
mutation must acquire the same lease. An explicit `--data-dir` is a separate
profile. State and config files use atomic replacement, private permissions,
ordered saves, and loud corruption failures.

Compound managed-state mutations own one serialized transaction. Cloudflare and
the local filesystem cannot participate in one atomic commit, so these managed
cross-system mutations write durable intent before their first remote side
effect, checkpoint remote success, and then either complete local state, retry
idempotently, or compensate. Any unfinished reconciliation remains visible in
the operation journal until recovery completes. Explicit whole-site
`pages deploy` is stateless and has no such journal; after an ambiguous timeout,
check Cloudflare deployment history before retrying.

### Backend and target identity are explicit

The canonical Cloudflare identity is `ProjectRef { accountId, projectName }`.
Hostnames and deployment URLs are metadata because Cloudflare can assign a
production hostname that differs from the requested project name.

Every snapshot, redirect, protection/expiry manifest, sync manifest, staging
tree, and last-known-good deployment is scoped by `ProjectRef`. Existing remote
projects used as managed publication targets require an ownership marker or
explicit adoption. Ambiguous legacy records stay quarantined until the operator
attaches the original target. Explicit direct deploy remains an intentional
replacement operation.

A Worker publication records `{ backend: "workers", profileId, origin, ownerId,
publicationId, activeVersionId }`. Existing Worker operations resolve that
stored profile instead of whichever profile is currently selected. Pages-only
report sync, password, edit, rename, expiry, and revoke paths exclude Worker
targets. Worker versions and access policies use the Worker API.

Worker credentials live in a separate private `0600` file. The browser sees an
allowlisted status projection, not the credential, bootstrap secret, password
hash, token digest, local capability, R2 key, or visitor identifier.

### Deploy complete desired state, then reconcile

Managed publishing materializes a fresh desired site for exactly one target;
it never incrementally mutates a shared staging tree. Each local target
generation swaps atomically with rollback. Cross-network workflows are
eventually consistent: publishing checkpoints remote success before local
finalization, content edits persist the local desired state before syncing each
target, and protection changes compensate already-updated targets after a later
failure. The operation journal makes every incomplete target explicit and
retryable.

Worker publishing stages an isolated Pages-compatible root. A single file does
not expose siblings; Markdown and non-index entries become `index.html`.
Uploads use immutable R2 keys, a canonical stored manifest, bounded parallel
streams, owner coordination, D1 receipts, and durable client checkpoints.
Access policy is applied before activation. The active-version pointer is the
only mutable delivery switch, so rollback activates an earlier complete version
without rewriting its files.

### Worker control and operations plane

The Worker uses D1 for owner, token, publication, access, collaboration,
analytics, audit, webhook, job, and idempotency state. R2 stores immutable
publication files, manifests, and generated artifacts. A Durable Object
serializes mutations for one owner. Queue consumers execute webhook and job
work; a 15-minute Cron repairs enqueue gaps, expired leases, retention, and due
work.

The Worker control API requires scoped bearer tokens, owner matching, and
Origin policy. Bootstrap authentication can create the first scoped token but
is not a publishing credential. One-time grant, invitation, token, and webhook
secrets are returned only by their creating or rotating mutation.

The remote `/mcp` route is stateless Streamable HTTP over the same control
services. It accepts only expiring scoped tokens, applies strict Host/Origin
allowlists, exposes explicit tool-to-scope mappings, and requires confirmation
for destructive tools. It cannot read local paths or execute local builds.

### Adapter parity

Dashboard, CLI, MCP, extension, goal, and auto-sync calls are adapters over the
same service contracts. They must agree on target selection, expiry, link kind,
context-aware publication identity, rollback, and response fields. A running
daemon may change transport, but must not change behavior or JSON shape.

### Analytics privacy boundary

Access events are keyed by immutable publication identity, not slug. D1 owns
append-only detailed events, atomic aggregate totals, and daily ingest limits.
The Worker HMACs a transient connecting address before constructing an event
and never persists or returns the raw value. Detailed events and unique rows
expire after 30 days; aggregates remain. Browser APIs expose an allowlisted
event shape only. The older optional Pages Activity Worker remains compatible
and separate from the V2 Worker dataset.

### Stable package boundary

`src/index.js` freezes the historical root API. Internal security, project,
state, publication-service, Wrangler-gateway, platform, and tunnel modules have
one-way dependencies and are composed by `src/server.js`; adding an internal
helper must not silently make it a package export.

## Lineage and corrected directions

| Lineage | Direction that stopped scaling | Current decision |
| --- | --- | --- |
| v0.1 tokens → PR #10 memorable names → PR #11 drops | Replacing entropy with word-only names made default links guessable and blurred unlisted links with public drops. | New unlisted links combine a memorable prefix with 128 random bits. Existing word-only links remain valid. Word-only custom/goal links are explicit drops. |
| PR #5 expiry and later password/expiry rollback fixes | Each endpoint implemented its own deploy-then-save ordering, so composed mutations could expose gates or state that the remote site did not have. | Shared workflows journal intent, compensate earlier targets after partial failure, retain retryable reconciliation state, and expose effective expiry on every adapter. |
| PR #9 Docker support | A container wildcard bind was treated like a normal local bind even though the admin API can execute builds. | Routable binds are rejected. Wildcard bind requires explicit loopback-proxy mode and loopback-only host port mapping. |
| PR #12 telemetry | Product telemetry needs a clear default without widening its anonymous payload. | Fresh installs are default-on with a first-run disclosure; saved choices, `DO_NOT_TRACK`, explicit environment overrides, and CI safeguards remain authoritative. |
| PR #15 sync/workbench → PR #17 target selection/recovery | Project selection, URL-derived identity, and a shared staging tree allowed current UI state to influence older publications. | `ProjectRef`, ownership markers, target-scoped desired-state trees, and explicit legacy adoption determine every mutation. |
| PR #15 preview workbench | Arbitrary preview HTML shared the privileged admin origin. | Preview content is isolated on the public origin with restrictive framing and response headers. |
| PR #16 MCP | A second in-process store was acceptable for listing but became a competing writer once initialization/migrations persisted state. | Reads are non-persisting or routed; mutations use the live owner or exclusive lease. |
| PR #8 Windows process support and later build commands | A generic shell-spawn workaround mixed platform quoting with user build-command semantics. | POSIX uses `sh -lc`; Windows uses `%ComSpec% /d /s /c`; argument-based Wrangler execution stays in its gateway. |
| Early release workflow → npm/Docker/extension releases | Publishing jobs could run without proving the exact source, generated bundle, package boundary, and component versions. | Release artifacts depend on one verification gate, exact component alignment, pinned action revisions and direct Wrangler version, installed-tarball smoke, and offline container proof. Registry transitive dependencies and remote publication are not an atomic/reproducible transaction. |
| Feature growth in `src/server.js` | Security, target, state, Wrangler, and service behavior accumulated in one compatibility module, making cross-feature invariants hard to see. | Extract acyclic policy/service modules while retaining `server.js` as the compatibility facade and composition root. |
| Pages-only lifecycle → Worker V2 | A shared report can contain both Pages and Worker publications, so treating every active snapshot as a Pages target can mutate the wrong backend. | Backend identity is stored per publication. Pages target selection excludes Worker rows; Worker operations use fixed owner-scoped endpoints and the publication's recorded profile. |

## Compatibility rules

- Existing publication URLs are not rotated automatically.
- Pages remains the default. Existing Pages publications are not migrated,
  revoked, or replaced automatically.
- Worker migration adds a second publication to the same report and preserves
  the Pages URL until an operator separately revokes it.
- Old word-only links keep resolving; they do not retroactively gain capability
  entropy.
- Legacy publications without account/project identity remain readable but
  cannot be mutated until explicitly attached to their original project.
- v0.4 background processes must restart once so v0.5 can establish the lease
  and private command descriptor. Old extension code must be reloaded for the
  CSRF handshake.
- Custom build commands are intentionally user-controlled and may remain
  platform-specific even though Pagecast selects the native command runner.

## Change checklist

Before merging a feature that publishes or mutates state, prove:

1. Which trust boundary receives the input?
2. Which process owns the workspace write?
3. Which exact `ProjectRef` receives every generated artifact?
4. What remains committed if the remote operation fails or the process exits?
5. Do all adapters return the same effective target, expiry, link kind, and
   result shape?
6. Does the package root remain unchanged unless an API addition is deliberate?
7. Do Linux, Windows, package, bundle, and container checks cover the change?
8. Does each report-level operation select only publications for its backend?
9. Does any Worker response expose a secret, storage key, visitor identifier,
   or another owner's record?
