# Chrome Web Store submission checklist

Everything needed to publish **Pagecast — Local to Public**.

## 1. Assets in this folder
- `listing.md` — name, summary, description, category, URLs (copy/paste into the
  dashboard).
- `PRIVACY.md` — privacy policy. Host it at a public URL (e.g. GitHub raw, or your
  own domain) and paste that URL into the "Privacy practices" tab.
- `screenshots/` — 1280×800 PNGs (upload 3–5; at least 1 required).
- `promo/marquee-1400x560.png`, `promo/small-tile-440x280.png` — optional promo
  images (recommended for featuring).
- Store icon: the extension's `icons/icon128.png` (128×128) is the store icon.

## 2. Build the upload zip
From the repo root:

```sh
cd extension
zip -r ../pagecast-extension.zip . -x "store/*" ".*"
```

This zips the extension WITHOUT the `store/` assets and dotfiles. Upload
`pagecast-extension.zip` in the dashboard ("Package" → "Upload new package").

## 3. Privacy practices answers (Web Store form)
- **Single purpose:** "Publish a local HTML/Markdown file you're viewing to a
  public link via your own locally-running Pagecast server."
- **Permission justifications:**
  - `activeTab`/`tabs` — read the active tab URL to detect a publishable `file://`
    page.
  - host permission `127.0.0.1`/`localhost` — send the file path to the Pagecast
    app running on the user's own machine.
  - `contextMenus` — the right-click "Publish to Pagecast" entry.
  - `notifications` — show the resulting link / errors after a right-click publish.
- **Data usage:** select **does NOT collect or use** user data. The extension only
  sends the local file path to the user's own loopback server; nothing reaches any
  remote/Pagecast server. No analytics, no selling, no transfer.
- **Remote code:** No. All code ships in the package; no remotely-hosted JS.

## 4. Listing fields
- Category: **Developer Tools**.
- Screenshots: from `screenshots/`.
- Homepage: `https://pagecasthq.pages.dev/`. Support:
  `https://github.com/Amal-David/pagecast/issues`.
- Privacy policy URL: the hosted `PRIVACY.md`.

## 5. Before you submit
- Replace the placeholder developer/brand details as needed.
- One-time: a Chrome Web Store **developer account** ($5 registration).
- Test the packaged zip via Load unpacked once more (`chrome://extensions`).
- Review can take a few days; "Allow access to file URLs" + the localhost host
  permission are fine but expect the reviewer to read the justifications above.

## Notes
- The icons here are generated brand marks (the broadcast glyph). They're
  production-usable; swap for higher-fidelity art anytime.
- The screenshots/promo are generated mockups — re-shoot with your real
  account/links if you want live URLs in them.
