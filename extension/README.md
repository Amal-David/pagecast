# Pagecast — Local to Public (Chrome extension)

When your coding agent writes an HTML file and opens it as `file:///…/report.html`,
this extension adds a one-click **Publish to Pagecast** button. It turns the local
file into an unlisted public link by talking to your **running** local Pagecast
server, which reads the file and deploys it to your own Cloudflare Pages.

Re-publishing the same file **updates the same URL** in place.

## Requirements

- Pagecast v0.5 running locally: `npx pagecast` (and Cloudflare connected once).
- The extension only acts on local `file://` pages ending in `.html`, `.htm`,
  `.md`, or `.markdown`.

After upgrading from v0.4, restart Pagecast once and reload/update the extension.
The v0.5 extension obtains a fresh admin-session token before publishing; an old
background process or old extension cannot complete that handshake.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. On the extension's card, open **Details** and enable
   **"Allow access to file URLs"** — Chrome needs this for the extension to read
   `file://` tab URLs. (Without it, the popup shows a reminder.)

## Use

1. Open a local HTML/Markdown file in Chrome (`file://…`).
2. Make sure `npx pagecast` is running and connected.
3. Either:
   - Click the Pagecast toolbar icon → **Publish to Pagecast** (shows the link with
     Copy / Open), or
   - **Right-click the page → "Publish to Pagecast"** — the public link opens
     automatically when it's ready, and a notification shows the result.
4. Copy or open the public link. Edit the file and publish again → same link updates.

## Notes

- A browser extension can't start the local server for you. If Pagecast isn't
  running, the popup tells you to run `npx pagecast` (with a copy button).
- The extension remembers the last verified Pagecast origin and can discover a
  persisted fallback port from the Pagecast dashboard tab that the CLI opens.
  On first use of a fallback port, that tab must still be open; after verification
  the origin is remembered. It never scans a port range. Host permissions cover
  `pagecast.localhost`, `localhost`, and `127.0.0.1`; custom loopback binds such
  as `127.0.0.2` and `::1` are not extension endpoints. It marks each request as
  the Pagecast adapter, fetches the current session token, and can access only
  `/api/session`, `/api/status`, and `/api/publish-local`; it cannot read general
  admin configuration.
- New links use Pagecast's unlisted capability URL shape. Anyone with the URL can
  view it; use password protection in the Pagecast app when recipients must
  authenticate.
- Web Store submission assets (listing copy, privacy policy, screenshots, promo
  images, packaging steps) live in `store/`.
- Icon filenames under `icons/` are referenced by `manifest.json` and
  `background.js`; keep `icon16.png`, `icon32.png`, `icon48.png`, and
  `icon128.png` stable unless every reference is updated together.
