"use strict";

const PUBLISHABLE = /\.(html?|md|markdown)(?:[?#].*)?$/i;
let activeBase = PagecastDiscovery.DEFAULT_BASES[0];

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const fileEl = $("file");
const publishBtn = $("publish");
const resultEl = $("result");
const resultUrl = $("result-url");
const resultNote = $("result-note");
const copyBtn = $("copy");
const openBtn = $("open");
const hintEl = $("hint");

function showHint(html) {
  hintEl.innerHTML = html;
  hintEl.hidden = false;
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

// Decode a file:// URL to a readable filesystem path (display only).
function displayPath(fileUrl) {
  try {
    return decodeURIComponent(new URL(fileUrl).pathname);
  } catch {
    return fileUrl;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getStatus() {
  const discovered = await PagecastDiscovery.discover(chrome, fetch, { timeoutMs: 2500 });
  if (!discovered) return { up: false };
  activeBase = discovered.base;
  return { up: true, data: discovered.data };
}

async function main() {
  const tab = await getActiveTab();
  const url = tab && tab.url ? tab.url : "";

  // 1. The page must be a local file:// HTML/Markdown file.
  if (!url || !url.startsWith("file://")) {
    if (tab && !url) {
      // file:// tab but URL is hidden → "Allow access to file URLs" is off.
      setStatus("Can't read this tab.");
      showHint(
        'If this is a local file, enable <strong>"Allow access to file URLs"</strong> for this extension on ' +
          '<a href="#" id="exts">chrome://extensions</a>, then reopen the file.'
      );
      const exts = $("exts");
      if (exts) exts.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "chrome://extensions" }); };
    } else {
      setStatus("Open a local HTML or Markdown file (file://…) to publish it.");
    }
    return;
  }
  if (!PUBLISHABLE.test(url)) {
    setStatus("Pagecast publishes .html, .htm, .md, or .markdown files.");
    return;
  }

  fileEl.textContent = displayPath(url);
  fileEl.hidden = false;

  // 2. The local Pagecast server must be running + connected.
  setStatus("Checking Pagecast…");
  const status = await getStatus();
  if (!status.up) {
    setStatus("Pagecast isn't running.");
    showHint(
      'Start it in your terminal:<br><code>npx pagecast</code><br>' +
        '<button class="btn" id="copycmd">Copy command</button>'
    );
    const c = $("copycmd");
    if (c) c.onclick = async () => { await navigator.clipboard.writeText("npx pagecast"); c.textContent = "Copied"; };
    return;
  }
  const cf = status.data && status.data.cloudflare;
  const configured = cf && cf.loggedIn && cf.projectName;
  if (configured && cf.requiresAdoption) {
    setStatus("Project adoption required.");
    showHint('Open <a href="' + activeBase + '" target="_blank" rel="noopener">Pagecast</a> and click Adopt for the current project, then come back.');
    return;
  }
  if (!configured) {
    setStatus("Cloudflare isn't connected yet.");
    showHint('Open <a href="' + activeBase + '" target="_blank" rel="noopener">Pagecast</a> and click Connect Cloudflare, then come back.');
    return;
  }

  // 3. Ready — enable Publish.
  setStatus("Ready to publish this file.");
  publishBtn.hidden = false;
  publishBtn.onclick = () => publish(url);
}

async function publish(fileUrl) {
  publishBtn.disabled = true;
  const original = publishBtn.textContent;
  publishBtn.innerHTML = '<span class="spin">↻</span> Publishing… (~30s)';
  hintEl.hidden = true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const csrfToken = await getCsrfToken(activeBase, controller.signal);
    const res = await fetch(`${activeBase}/api/publish-local`, {
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
    if (!res.ok || !data.url) {
      handleError(res.status, data);
      return;
    }
    statusEl.hidden = true;
    publishBtn.hidden = true;
    resultUrl.textContent = data.url;
    resultUrl.href = data.url;
    const expiryNote = PagecastExpiry.format(data.publication?.expiresAt);
    resultNote.textContent = `${
      data.updated ? "Updated the existing link." : "New public link created."
    } ${expiryNote}`;
    resultEl.hidden = false;
    copyBtn.onclick = async () => { await navigator.clipboard.writeText(data.url); copyBtn.textContent = "Copied"; };
    openBtn.onclick = () => chrome.tabs.create({ url: data.url });
  } catch (err) {
    setStatus("Publish failed.");
    showHint("The publish timed out or the connection dropped. Check the Pagecast terminal, then try again.");
    publishBtn.disabled = false;
    publishBtn.textContent = original;
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
    throw new Error(`Could not establish an admin session (${response.status})`);
  }
  const session = await response.json();
  if (!session || typeof session.csrfToken !== "string" || !session.csrfToken) {
    throw new Error("Admin session did not include a CSRF token");
  }
  return session.csrfToken;
}

function handleError(statusCode, data) {
  const msg = data && data.error && data.error.message;
  publishBtn.disabled = false;
  publishBtn.textContent = "Publish to Pagecast";
  if (statusCode === 401) {
    setStatus("Cloudflare isn't connected.");
    showHint('Open <a href="' + activeBase + '" target="_blank" rel="noopener">Pagecast</a> to sign in, then try again.');
  } else if (statusCode === 409) {
    setStatus("Multiple Cloudflare accounts found.");
    showHint('Open <a href="' + activeBase + '" target="_blank" rel="noopener">Pagecast</a> and choose an account, then try again.');
  } else if (statusCode === 404) {
    setStatus("File not found.");
    showHint("Is the file still on disk at this path?");
  } else {
    setStatus("Couldn't publish.");
    showHint(msg ? String(msg) : "Check the Pagecast terminal for details.");
  }
}

main().catch((err) => {
  setStatus("Something went wrong.");
  showHint(String(err && err.message ? err.message : err));
});
