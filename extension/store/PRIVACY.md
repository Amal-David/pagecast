# Privacy Policy — Pagecast: Local to Public

_Last updated: 2026-06-11_

The Pagecast "Local to Public" extension is designed to be private by default. It
does **not** collect, store, sell, or transmit your personal data to us or to any
third party.

## What the extension accesses
- **The active tab's URL**, only when you click the extension button or its
  right-click menu. It uses this to detect that you're viewing a local
  `file://` HTML/Markdown file and to learn the file's path.

## Where data goes
- When you click Publish, the extension sends the **local file path** to the
  Pagecast app **running on your own computer** at `http://127.0.0.1:4173` (your
  loopback address). That local app reads the file and deploys it to **your own**
  Cloudflare Pages account.
- The extension makes **no requests to any Pagecast-operated server.** There is no
  Pagecast backend that receives your files, paths, or browsing data.
- The published page itself lives on **your** Cloudflare account, under your
  control. You can revoke it anytime from the Pagecast app.

## What we do NOT do
- No analytics, telemetry, tracking, cookies, or fingerprinting in the extension.
- No remote data collection. No selling or sharing of any data.
- No access to your browsing history or to pages other than the active tab you
  explicitly act on.

## Permissions, and why
- `activeTab` / `tabs`: read the active tab's URL to detect a publishable local file.
- `host_permissions` for `127.0.0.1` / `localhost`: talk to the Pagecast app
  running on your own machine.
- `contextMenus`: add the right-click "Publish to Pagecast" item.
- `notifications`: show the resulting link / errors after a right-click publish.

## Contact
Questions or requests: https://github.com/Amal-David/pagecast/issues
