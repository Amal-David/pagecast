"use strict";

// Exact-origin discovery for Pagecast's persisted/fallback admin port. The CLI
// opens the dashboard after startup, so the extension can inspect that local tab
// and remember the origin that proves itself via Pagecast's status marker. It
// never probes a port range.
(function installPagecastDiscovery(global) {
  const STORAGE_KEY = "pagecastAdminOrigin";
  const PROTOCOL_VERSION = 1;
  const DEFAULT_BASES = Object.freeze([
    "http://pagecast.localhost",
    "http://pagecast.localhost:4173",
    "http://127.0.0.1:4173"
  ]);
  const TAB_PATTERNS = Object.freeze([
    "http://*.localhost/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ]);

  function isLoopbackHostname(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
    const octets = normalized.split(".");
    return (
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  }

  function normalizeBase(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch {
      return null;
    }
    if (
      parsed.protocol !== "http:" ||
      !isLoopbackHostname(parsed.hostname) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.origin;
  }

  async function storedBase(chromeApi) {
    try {
      const stored = await chromeApi.storage.local.get(STORAGE_KEY);
      return normalizeBase(stored?.[STORAGE_KEY]);
    } catch {
      return null;
    }
  }

  async function tabBases(chromeApi) {
    try {
      const tabs = await chromeApi.tabs.query({ url: [...TAB_PATTERNS] });
      return tabs.map((tab) => normalizeBase(tab?.url)).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function candidates(chromeApi) {
    const values = [await storedBase(chromeApi), ...(await tabBases(chromeApi)), ...DEFAULT_BASES];
    return [...new Set(values.filter(Boolean))];
  }

  async function remember(chromeApi, base) {
    const normalized = normalizeBase(base);
    if (!normalized) return false;
    await chromeApi.storage.local.set({ [STORAGE_KEY]: normalized });
    return true;
  }

  function isPagecastStatus(value) {
    return (
      value?.admin?.ok === true &&
      value.admin.product === "pagecast" &&
      value.admin.protocolVersion === PROTOCOL_VERSION
    );
  }

  async function discover(chromeApi, fetchImpl = fetch, { timeoutMs = 2500 } = {}) {
    for (const base of await candidates(chromeApi)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${base}/api/status`, {
          headers: { "X-Pagecast-Extension": "1" },
          signal: controller.signal
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (!isPagecastStatus(data)) continue;
        await remember(chromeApi, base);
        return { base, data };
      } catch {
        // Stale remembered origins and unrelated localhost tabs are expected.
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  global.PagecastDiscovery = Object.freeze({
    DEFAULT_BASES,
    PROTOCOL_VERSION,
    STORAGE_KEY,
    candidates,
    discover,
    isPagecastStatus,
    normalizeBase,
    remember
  });
})(globalThis);
