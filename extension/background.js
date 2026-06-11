"use strict";

// Right-click "Publish to Pagecast" on a local file:// page. Mirrors the popup's
// publish flow, but surfaces the result via a notification (and opens the link).
const BASE = "http://127.0.0.1:4173";
const PUBLISHABLE = /\.(html?|md|markdown)(?:[?#].*)?$/i;
const MENU_ID = "pagecast-publish";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Publish to Pagecast",
    contexts: ["page", "link"],
    documentUrlPatterns: ["file:///*"],
    targetUrlPatterns: ["file:///*"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const fromLink = info.linkUrl && info.linkUrl.startsWith("file://") ? info.linkUrl : "";
  const url = fromLink || info.pageUrl || (tab && tab.url) || "";
  if (!url.startsWith("file://") || !PUBLISHABLE.test(url)) {
    notify("Pagecast", "Open a local .html, .htm, .md, or .markdown file to publish it.");
    return;
  }
  await publish(url);
});

async function publish(fileUrl) {
  notify("Pagecast", "Publishing… this takes ~30s.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${BASE}/api/publish-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileUrl }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      const message = data && data.error && data.error.message;
      if (res.status === 401) return notify("Connect Cloudflare", "Open Pagecast to sign in, then try again.");
      if (res.status === 409) return notify("Choose an account", "Open Pagecast and pick a Cloudflare account.");
      if (res.status === 404) return notify("File not found", "Is the file still on disk?");
      return notify("Couldn't publish", message || "Check the Pagecast terminal.");
    }
    chrome.tabs.create({ url: data.url });
    notify(
      data.updated ? "Updated on Pagecast" : "Published to Pagecast",
      data.updated ? "Your existing link now shows the latest version." : data.url
    );
  } catch {
    notify("Pagecast isn't running", "Start it in your terminal: npx pagecast");
  } finally {
    clearTimeout(timer);
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: String(message).slice(0, 250)
  });
}
