# Pagecast — Local to Public (Chrome extension)

When your coding agent writes an HTML file and opens it as `file:///…/report.html`,
this extension adds a one-click **Publish to Pagecast** button. It turns the local
file into a public link by talking to your **running** local Pagecast server,
which reads the file and deploys it to your own Cloudflare Pages.

Re-publishing the same file **updates the same URL** in place.

## Requirements
- Pagecast running locally: `npx pagecast` (and Cloudflare connected once).
- The extension only acts on local `file://` pages ending in `.html`, `.htm`,
  `.md`, or `.markdown`.

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
- The extension talks only to `http://127.0.0.1:4173`; the admin server reflects
  CORS only for `chrome-extension://` origins.
- Web Store submission assets (listing copy, privacy policy, screenshots, promo
  images, packaging steps) live in `store/`.
