# Chrome Web Store submission checklist

Everything needed to publish **Pagecast — Local to Public**.

## 1. Assets in this folder

- `listing.md` — name, summary, description, category, URLs (copy/paste into the
  dashboard).
- `PRIVACY.md` — privacy policy. Host it at a public URL (e.g. GitHub raw, or your
  own domain) and paste that URL into the "Privacy practices" tab.
- `screenshots/` — 1280×800 PNGs, named with a two-digit display-order prefix
  (`01-one-click.png`, `02-click-publish.png`, `03-right-click.png`). Upload
  3–5; at least 1 is required.
- `promo/marquee-1400x560.png`, `promo/small-tile-440x280.png` — optional promo
  images. The dimensions are part of the filename and match the Web Store slots.
- Store icon: `icons/icon128.png` (128×128). The packaged manifest also refers
  to `icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`; do not rename
  these without updating `manifest.json` and `background.js` together.

## 2. Build the upload zip

From the repo root:

```sh
cd extension
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')).version")"
zip -r "../pagecast-extension-v${VERSION}.zip" . -x "store/*" ".*"
```

This zips the extension WITHOUT the `store/` assets and dotfiles. Upload
`pagecast-extension-v<VERSION>.zip` in the dashboard ("Package" → "Upload new
package"). Tagged GitHub releases read the same manifest version and use the
same `pagecast-extension-v<VERSION>.zip` convention, for example
`pagecast-extension-v0.7.0.zip`.

## 3. Privacy practices answers (Web Store form)

- **Single purpose:** "Publish a local HTML/Markdown file you're viewing to a
  public link via your own locally-running Pagecast server."
- **Permission justifications:**
  - `activeTab`/`tabs` — read the active file URL and discover the exact origin of
    an already-open local Pagecast dashboard when it uses a fallback port.
  - `storage` — remember the last verified local Pagecast origin; no report
    content or public URL is stored.
  - host permission `pagecast.localhost`/`127.0.0.1`/`localhost` — send the file
    path to the Pagecast app running on the user's own machine.
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

- Confirm `extension/manifest.json` matches the npm package and plugin release
  version. For this release all package-facing metadata is `0.7.0`.
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
- Keep screenshot ordering prefixes and promo dimension suffixes when replacing
  art; the names document their intended Web Store slot and make release review
  deterministic.
