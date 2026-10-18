# Bounded synthetic evaluation

Checked on 2026-10-16. No paid model requests, live Cloudflare deployments,
credential setup, or private content uploads are part of these checks.

## Recorded results

- Node 24.19.0: full regression suite **490 passed, 0 failed**, with the outbound
  fetch guard and an isolated writable HOME; native helper built with Go 1.27.2.
- AI-focused suite: **58 passed, 0 failed** on Node 24.19.0 and a supplemental
  Node 20.19.0 run. Provider SDKs still officially require Node 22+; that extra
  compatibility observation does not lower their supported engine requirement.
- Syntax checks and `git diff --check`: passed.
- Official plugin/MCP JSON Schema validation: passed.
- Local production-dependency tarball installation, AI package exports,
  read-only empty-library call and MCP executable wiring: passed.

The local tarball is a smoke-test artifact, not a completed cross-platform
release build. No web UI changed; dashboard rebuild and real-client installation
were outside this verification run.

## Reproduce

Use Node 22+ and the repository's pinned Go toolchain for native cleanup tests.
Install from the lockfile with `npm ci --ignore-scripts`, then:

```sh
npm run check
npm run test:ai
# POSIX shell; inherit this guard into test child processes too.
PAGECAST_TELEMETRY=0 DO_NOT_TRACK=1 \
NODE_OPTIONS="--import=$(pwd)/scripts/offline-fetch-guard.mjs" npm test
```

Run under a writable, isolated HOME if the current home is read-only. The fetch
guard allows loopback and data-URI fixtures, rejects external global fetch calls,
and fails the process even if application code catches the rejection. It is a
verification safeguard, not an OS-level network sandbox; mocked subprocess and
HTTP dependencies still need review.

## Follow-up: publication receipts

The initial local delivery was `ec73d8a`, based on main `1a5d491`; package version
`0.7.1` identifies that unreleased source baseline, not a registry publication.
A local follow-up prompted by the separate PR #35 review fixes analogous
post-mutation result loss in our SDK examples and result projection boundary.
PR #35 itself is not changed. The follow-up uses only synthetic publication and
provider fixtures; it makes no real publication.

Added regression cases cover successful publish followed by provider failure,
turn limits, malformed later tool envelopes, Vercel multi-approval resumption,
replay prevention, uncertain outcomes, bounded/redacted receipts, and the
64-operation workflow limit. Known successes retain their public URLs; uncertain
outcomes never invent success. Prior full-suite results above are retained as
baseline evidence. The follow-up AI suite passes **84/84** under the outbound-fetch
guard; syntax/diff checks and an installed-tarball receipt export smoke pass.
The full regression suite was not rerun for this bounded follow-up.

## Test scope

- Native tool contracts: strict OpenAI schemas, nullable optionals, Anthropic
  tool-result identifiers/errors, AI SDK JSON schemas and real mocked executor.
- Bounded loops: OpenAI/Claude up to eight turns and eight calls per turn; Vercel
  one shared budget of up to eight generation steps across approval resumptions.
- Authorization: reads only by default; host opt-in and exact frozen-argument
  approval are both required for writes. SDK approval cannot override host denial.
- Publishing: missing/unadopted target fails before auth, discovery, deploy or
  persistent report/config changes; signed-out status cannot launch login;
  existing configured-target publication skips project discovery/provisioning;
  cross-project update and occupied writer lease fail closed.
- Content isolation: concurrent calls and repeated item keys use fresh staging
  directories, so a snapshot cannot pick up an older staged sibling filename.
- Protocol: official MCP SDK in-memory, stdio child process, Streamable HTTP
  client/server; real initialization, tool listing, calls and structured results.
- HTTP: loopback-only listener, bearer auth, exact Host/Origin, method/path/media
  limits, request-body ceiling, write-disabled catalog and result/error redaction.
- Provider SDKs: real OpenAI, Anthropic and Vercel SDK packages, with synthetic
  fetch/model fixtures; Vercel approve/deny, replay, exhausted budget and
  post-execution failure cases. No provider network transport is used.
- Packaging: installed local tarball imports, executable read-only stdio entry,
  hidden plugin metadata included, portable manifests checked against the
  official Agent Plugins 1.0.0 schemas, per-client config consistency.

Three pre-existing regression fixtures were made genuinely local: two feedback
migration flows now capture/assert the synthetic POST payload instead of sending
it to a fake Worker hostname; a protected-deploy failure fixture adopts its
synthetic target first and asserts the intended deployment failure, rather than
failing earlier on an ownership probe.

## What this does not establish

These are deterministic contract and safety evaluations, not model-quality
scores. They do not prove that every assistant will choose the right report,
that desktop clients are installed, or that a plugin marketplace accepted the
package. The remote Vercel example is a documented client lifecycle, not a hosted
service verification. Production model quality, Cloudflare staging tests,
authenticated remote transport, tenant isolation, real-client installation and
marketplace review remain explicit release gates in the integration guide.

## Fresh-VM revalidation: 2026-10-18

Recovered the reviewed source against unchanged main `1a5d491` and reran the
complete suite including the publication-receipt follow-up: **516 passed,
0 failed, 0 skipped** on Node 24.19.0. The run used the outbound-fetch guard,
an isolated writable HOME, telemetry opt-outs and a freshly built native helper
from the pinned Go 1.27.2 toolchain. The 84 AI-specific tests also passed.

All six native cleanup targets cross-compiled; the dashboard production build,
TypeScript check and syntax checks passed. The rebuilt dashboard is byte-for-byte
unchanged in Git. Portable plugin/MCP manifests validate against the official
Agent Plugins 1.0.0 schemas (the same schema hashes recorded by the companion
integration). A fresh packed install includes the hidden manifests and all AI
exports; its read-only empty-library call and packaged Linux cleanup smoke pass.
Cross-compilation is not runtime verification on Windows/macOS. Container build,
physical/desktop client installation, hosted integration and provider-backed
publishing remain unrun. No registry release or live cloud mutation occurred.

Initial build invocations encountered the VM's read-only default package-store
location; rerunning with a workspace-local store and the repository's pnpm 10
major resolved the environment issue without changing package locks or scripts.
