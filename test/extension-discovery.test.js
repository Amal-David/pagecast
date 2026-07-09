import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

async function loadDiscovery() {
  const context = { AbortController, URL, clearTimeout, setTimeout };
  vm.runInNewContext(await source("extension/discovery.js"), context, {
    filename: "extension/discovery.js"
  });
  return context.PagecastDiscovery;
}

test("extension discovery uses a verified open dashboard tab for a fallback port", async () => {
  const discovery = await loadDiscovery();
  const stored = { pagecastAdminOrigin: "http://pagecast.localhost:4999" };
  let query = null;
  const chromeApi = {
    storage: {
      local: {
        async get() {
          return { ...stored };
        },
        async set(value) {
          Object.assign(stored, value);
        }
      }
    },
    tabs: {
      async query(options) {
        query = options;
        return [
          { url: "http://pagecast.localhost:4177/settings" },
          { url: "http://localhost:9000/unrelated" }
        ];
      }
    }
  };
  const attempts = [];
  const fetchImpl = async (url) => {
    attempts.push(url);
    if (url === "http://pagecast.localhost:4177/api/status") {
      return {
        ok: true,
        async json() {
          return { admin: { ok: true, product: "pagecast", protocolVersion: 1 } };
        }
      };
    }
    throw new Error("not Pagecast");
  };

  const found = await discovery.discover(chromeApi, fetchImpl, { timeoutMs: 100 });

  assert.equal(found.base, "http://pagecast.localhost:4177");
  assert.equal(stored.pagecastAdminOrigin, "http://pagecast.localhost:4177");
  assert.deepEqual(Array.from(query.url), [
    "http://*.localhost/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ]);
  assert.deepEqual(attempts, [
    "http://pagecast.localhost:4999/api/status",
    "http://pagecast.localhost:4177/api/status"
  ]);
});

test("extension discovery rejects foreign origins and non-Pagecast localhost services", async () => {
  const discovery = await loadDiscovery();
  assert.equal(discovery.normalizeBase("https://pagecast.localhost:4173"), null);
  assert.equal(discovery.normalizeBase("http://attacker.example:4173"), null);
  assert.equal(discovery.normalizeBase("http://127.999.0.1:4173"), null);
  assert.equal(discovery.normalizeBase("http://dev.pagecast.localhost:4177/path"), "http://dev.pagecast.localhost:4177");
  assert.equal(discovery.isPagecastStatus({ admin: { ok: true } }), false);
});

test("popup and background share discovery without probing a fallback port range", async () => {
  const [popupHtml, popup, background, discovery] = await Promise.all([
    source("extension/popup.html"),
    source("extension/popup.js"),
    source("extension/background.js"),
    source("extension/discovery.js")
  ]);

  assert.match(popupHtml, /discovery\.js[\s\S]*expiry\.js[\s\S]*popup\.js/);
  assert.match(background, /importScripts\("expiry\.js", "discovery\.js"\)/);
  assert.match(popup, /PagecastDiscovery\.discover/);
  assert.match(background, /PagecastDiscovery\.discover/);
  assert.match(popup, /cf\.requiresAdoption/);
  assert.match(background, /cloudflare\?\.requiresAdoption/);
  assert.match(`${popup}\n${background}`, /explicitly adopt|click Adopt/);
  assert.doesNotMatch(discovery, /for\s*\([^)]*(?:4173|port)/i);
});
