"use strict";

importScripts("expiry.js", "discovery.js", "errors.js");

// Right-click "Publish to Pagecast" on a local file:// page. Mirrors the popup's
// publish flow, but surfaces the result via a notification (and opens the link).
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
  const discovered = await PagecastDiscovery.discover(chrome, fetch, { timeoutMs: 2500 });
  if (!discovered) {
    notify("Pagecast isn't running", "Start it in your terminal: npx pagecast");
    return;
  }
  if (discovered.data?.cloudflare?.requiresAdoption) {
    notify("Adopt the current project", "Open Pagecast and explicitly adopt the selected Cloudflare project, then try again.");
    chrome.tabs.create({ url: discovered.base });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const csrfToken = await getCsrfToken(discovered.base, controller.signal);
    const res = await fetch(`${discovered.base}/api/publish-local`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pagecast-Extension": "1",
        "X-Pagecast-CSRF": csrfToken
      },
      body: JSON.stringify({ path: fileUrl }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url) {
      const message = data && data.error && data.error.message;
      if (res.status === 401) return notify("Connect Cloudflare", "Open Pagecast to sign in, then try again.");
      if (res.status === 409) return notify("Choose an account", "Open Pagecast and pick a Cloudflare account.");
      if (res.status === 404) return notify("File not found", "Is the file still on disk?");
      return notify("Couldn't publish", message || "Check the Pagecast terminal.");
    }
    chrome.tabs.create({ url: data.url });
    const expiryNote = PagecastExpiry.format(data.publication?.expiresAt);
    notify(
      data.updated ? "Updated on Pagecast" : "Published to Pagecast",
      data.updated
        ? `Your existing link now shows the latest version. ${expiryNote}`
        : `${data.url}\n${expiryNote}`
    );
  } catch (error) {
    notify("Publish failed", PagecastExtensionErrors.publishFailureMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

async function getCsrfToken(base, signal) {
  const response = await fetch(`${base}/api/session`, {
    headers: { "X-Pagecast-Extension": "1" },
    signal
  });
  if (!response.ok) {
    throw PagecastExtensionErrors.adminSessionError(response.status);
  }
  const session = await response.json().catch(() => null);
  if (!session || typeof session.csrfToken !== "string" || !session.csrfToken) {
    throw PagecastExtensionErrors.adminSessionError();
  }
  return session.csrfToken;
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: String(message).slice(0, 250)
  });
}
