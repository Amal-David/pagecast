# Privacy Policy — Pagecast: Local to Public

_Last updated: 2026-07-09_

The Pagecast "Local to Public" extension is designed to minimize local data access. It
does **not** collect, store, sell, or transmit your personal data to us or to any
third party.

## What the extension accesses

- **The active tab's URL**, only when you click the extension button or its
  right-click menu. It uses this to detect that you're viewing a local
  `file://` HTML/Markdown file and to learn the file's path.
- **Origins of open loopback tabs** (`localhost`, `*.localhost`, or
  `127.0.0.1`), only to find the Pagecast dashboard when it is running on a
  persisted fallback port. The extension verifies Pagecast's status marker
  before using or remembering an origin and does not probe a port range.

## Where data goes

- When you click Publish, the extension sends the **local file path** to the
  Pagecast app **running on your own computer** at `http://pagecast.localhost`
  when configured, or `http://127.0.0.1:4173` (your loopback address) otherwise.
  That local app reads the file and deploys it to **your own** Cloudflare Pages
  account.
- Before publishing, the extension fetches a per-process Pagecast admin-session
  token from the same loopback server and sends it back with the publish request.
  The token remains local and rotates when the Pagecast process restarts.
- The extension makes **no requests to any Pagecast-operated server.** There is no
  Pagecast backend that receives your files, paths, or browsing data.
- The last verified local Pagecast origin is stored in Chrome extension storage.
  No file path, report content, or public link is stored there.
- The published page itself lives on **your** Cloudflare account, under your
  control. You can revoke it anytime from the Pagecast app.

## What we do NOT do

- No analytics, telemetry, tracking, cookies, or fingerprinting in the extension.
- No remote data collection. No selling or sharing of any data.
- No access to remote browsing history. Local tab URLs are filtered to loopback
  origins solely for Pagecast discovery.

## Permissions, and why

- `activeTab` / `tabs`: read the active file URL and find an already-open local
  Pagecast dashboard on its exact fallback port.
- `storage`: remember the last verified local Pagecast origin.
- `host_permissions` for `pagecast.localhost` / `127.0.0.1` / `localhost`: talk
  to the Pagecast app running on your own machine. The Pagecast server accepts
  extension requests only on its session, status, and local-publish adapter
  routes.
- `contextMenus`: add the right-click "Publish to Pagecast" item.
- `notifications`: show the resulting link / errors after a right-click publish.

## Contact

Questions or requests: https://github.com/Amal-David/pagecast/issues
