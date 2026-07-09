"use strict";

// Shared by the popup and service worker so every extension publish result
// states the effective server-side lifetime, including explicit permanent links.
globalThis.PagecastExpiry = Object.freeze({
  format(expiresAt) {
    const value = Number(expiresAt);
    if (!Number.isFinite(value) || value <= 0) {
      return "Expires: never.";
    }
    return `Expires: ${new Date(value).toISOString()}.`;
  }
});
