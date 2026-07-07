// Zero-dependency password-protection helpers for pagecast.
//
// Pagecast gates protected published pages at the EDGE: a generated Cloudflare
// Pages Function (functions/_middleware.js) checks an HTTP Basic Auth password
// against a salted PBKDF2 hash baked into the function. Content is deployed
// plain and only served after a correct password, so it is never offline-
// brute-forceable — the hash is never published as a static asset, and the only
// attack is online guessing (slow, rate-limitable).
//
// This module owns three things, all dependency-free (node:crypto only):
//   1. makePasswordHash — the Node-side hash stored on a report. It must match
//      the WebCrypto PBKDF2 run inside the generated middleware (cross-runtime
//      parity is asserted in test/crypto.test.js).
//   2. renderAuthMiddleware — the generated functions/_middleware.js source.
//   3. renderRoutesJson — the generated _routes.json that scopes the Function
//      to protected /p/<slug>/ prefixes only, so unprotected sites stay static.

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

// PBKDF2 cost. Lower than the 600k you'd use for a publicly-downloadable blob:
// here the hash is never served, so stretching is defense-in-depth, not the
// primary boundary, and a modest count keeps per-request edge CPU small.
export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_HASH = "sha256";
const KEY_LEN = 32;
const SALT_LEN = 16;

// _routes.json supports at most 100 include rules; beyond that we fall back to a
// single /p/* rule (all publications hit the Function, still better than /*).
const MAX_ROUTE_RULES = 100;

// Derive the salted PBKDF2 hash stored for a protected report. Returns the salt
// and iterations alongside the hash so the generated middleware (and a re-check)
// can reproduce it. Throws on an empty password.
export function makePasswordHash(
  password,
  { salt = randomBytes(SALT_LEN).toString("hex"), iterations = PBKDF2_ITERATIONS } = {}
) {
  const normalized = String(password ?? "");
  if (!normalized) {
    throw new Error("A non-empty password is required.");
  }
  const hash = pbkdf2Sync(normalized, Buffer.from(salt, "hex"), iterations, KEY_LEN, PBKDF2_HASH).toString("hex");
  return { salt, hash, iterations };
}

// Constant-time check of a candidate password against a stored hash entry.
// Used server-side (the middleware carries its own WebCrypto copy of this).
export function passwordHashMatches(password, entry) {
  if (!isValidPasswordHash(entry)) {
    return false;
  }
  const normalized = String(password ?? "");
  if (!normalized) {
    return false;
  }
  const computed = makePasswordHash(normalized, { salt: entry.salt, iterations: entry.iterations }).hash;
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(entry.hash, "hex");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

// Shape guard so corrupt/legacy state degrades to "not protected" rather than
// throwing or, worse, deploying a broken gate.
export function isValidPasswordHash(entry) {
  return Boolean(
    entry &&
      typeof entry.salt === "string" &&
      /^[0-9a-f]+$/i.test(entry.salt) &&
      typeof entry.hash === "string" &&
      /^[0-9a-f]+$/i.test(entry.hash) &&
      Number.isInteger(entry.iterations) &&
      entry.iterations > 0
  );
}

export const PAGECAST_SYNC_MANIFEST_PATH = "/__pagecast/manifest.json";

// The generated _routes.json. Only protected prefixes and Pagecast's private
// sync endpoint invoke the Function; everything else stays static.
export function renderRoutesJson(slugs, { includeSyncEndpoint = false } = {}) {
  const unique = [...new Set((slugs || []).filter(Boolean))];
  const maxSlugRules = includeSyncEndpoint ? MAX_ROUTE_RULES - 1 : MAX_ROUTE_RULES;
  let include;
  if (unique.length === 0) {
    include = [];
  } else if (unique.length > maxSlugRules) {
    include = ["/p/*"];
  } else {
    include = unique.map((slug) => `/p/${slug}/*`);
  }
  if (includeSyncEndpoint) {
    include.push(PAGECAST_SYNC_MANIFEST_PATH);
  }
  return `${JSON.stringify({ version: 1, include, exclude: [] }, null, 2)}\n`;
}

// The public "this page is protected" body returned with the 401 (shown if the
// browser's native Basic-auth prompt is dismissed). Carries the growth-loop
// badge unless white-labelled, since this is the one publicly-visible surface.
function renderGateHtml({ badge = true } = {}) {
  const badgeHtml = badge
    ? '\n    <a class="badge" href="https://pagecasthq.pages.dev/?ref=badge" target="_blank" rel="noopener">' +
      'Published with <strong>Pagecast</strong></a>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password required</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: #fafafa; color: #27272a; }
  .card { max-width: 22rem; padding: 2rem; text-align: center; }
  .lock { font-size: 2rem; }
  h1 { font-size: 1.1rem; margin: .75rem 0 .35rem; }
  p { margin: 0; color: #71717a; }
  .badge { display: inline-block; margin-top: 1.5rem; padding: 6px 11px; font-size: 12px;
    color: #52525b; text-decoration: none; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 999px; }
  .badge strong { color: #c9530a; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <div class="lock">&#128274;</div>
    <h1>This page is password protected</h1>
    <p>Enter the password to view it.</p>${badgeHtml}
  </div>
</body>
</html>
`;
}

// The public "this link has expired" body returned with the 410. Same shape as
// the gate page; carries the growth-loop badge unless white-labelled.
function renderExpiredHtml({ badge = true } = {}) {
  const badgeHtml = badge
    ? '\n    <a class="badge" href="https://pagecasthq.pages.dev/?ref=badge" target="_blank" rel="noopener">' +
      'Published with <strong>Pagecast</strong></a>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link expired</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: #fafafa; color: #27272a; }
  .card { max-width: 22rem; padding: 2rem; text-align: center; }
  .icon { font-size: 2rem; }
  h1 { font-size: 1.1rem; margin: .75rem 0 .35rem; }
  p { margin: 0; color: #71717a; }
  .badge { display: inline-block; margin-top: 1.5rem; padding: 6px 11px; font-size: 12px;
    color: #52525b; text-decoration: none; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 999px; }
  .badge strong { color: #c9530a; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">&#9203;</div>
    <h1>This link has expired</h1>
    <p>The page is no longer available.</p>${badgeHtml}
  </div>
</body>
</html>
`;
}

// The static logic of the generated middleware. Authored with plain string
// concatenation (no template literals, no regex) so it embeds cleanly with no
// escaping, and references the constants prepended by renderAuthMiddleware
// (PROTECTED, COOKIE_SECRET, GATE_HTML, EXPIRED_HTML).
const MIDDLEWARE_BODY = `const REALM = "Pagecast protected report";
const COOKIE_TTL = 43200; // seconds (12h)

const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function hashPassword(password, saltHex, iterations) {
  // password is the raw byte string from atob() (each char is one credential
  // byte, 0-255). Browsers send Basic-auth credentials UTF-8 encoded, so these
  // ARE the UTF-8 bytes — take them as-is. Re-encoding via TextEncoder would
  // double-encode any byte > 127, so a non-ASCII password would never match the
  // Node-side pbkdf2Sync(Buffer.from(pw, "utf8")) hash.
  const pwBytes = new Uint8Array(password.length);
  for (let i = 0; i < password.length; i += 1) pwBytes[i] = password.charCodeAt(i) & 0xff;
  const keyMaterial = await crypto.subtle.importKey("raw", pwBytes, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

async function sign(value) {
  const key = await crypto.subtle.importKey("raw", fromHex(COOKIE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function matchSlug(pathname) {
  if (!pathname.startsWith("/p/")) return null;
  const rest = pathname.slice(3);
  const end = rest.indexOf("/");
  if (end <= 0) return null;
  const slug = rest.slice(0, end);
  return Object.prototype.hasOwnProperty.call(PROTECTED, slug) ? slug : null;
}

function syncManifestResponse(url) {
  if (url.pathname !== PAGECAST_SYNC_MANIFEST_PATH) return null;
  const token = url.searchParams.get("token");
  if (!SYNC_TOKEN || !token || !constantTimeEqual(token, SYNC_TOKEN)) {
    return new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  return new Response(JSON.stringify(SYNC_MANIFEST), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i].trim();
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function unauthorized() {
  return new Response(GATE_HTML, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="' + REALM + '", charset="UTF-8"',
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function gone() {
  return new Response(EXPIRED_HTML, {
    status: 410,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function onRequest(context) {
  const request = context.request;
  const next = context.next;
  const url = new URL(request.url);
  const manifest = syncManifestResponse(url);
  if (manifest) return manifest;
  const slug = matchSlug(url.pathname);
  if (!slug) return next();
  const entry = PROTECTED[slug];

  // Expiry is enforced first: an expired link is gone for everyone, including
  // anyone who knows the password.
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    return gone();
  }
  // Expiry-only entry (no password) — the expiry check above is the whole gate.
  if (!entry.hash) {
    return next();
  }

  // Fast path: a valid signed session cookie skips PBKDF2 so a multi-asset page
  // only pays the hashing cost on the first request, not for every sub-asset.
  const cookie = readCookie(request, "pc_" + slug);
  if (cookie && COOKIE_SECRET) {
    const sep = cookie.lastIndexOf(".");
    if (sep > 0) {
      const exp = cookie.slice(0, sep);
      const sig = cookie.slice(sep + 1);
      if (Number(exp) > Date.now() && constantTimeEqual(await sign(slug + "." + exp), sig)) {
        return next();
      }
    }
  }

  const auth = request.headers.get("Authorization") || "";
  if (auth.indexOf("Basic ") === 0) {
    let decoded = "";
    try { decoded = atob(auth.slice(6)); } catch (err) { decoded = ""; }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (password) {
      const computed = await hashPassword(password, entry.salt, entry.iterations);
      if (constantTimeEqual(computed, entry.hash)) {
        const response = await next();
        if (COOKIE_SECRET) {
          const exp = Date.now() + COOKIE_TTL * 1000;
          const value = exp + "." + (await sign(slug + "." + exp));
          response.headers.append(
            "Set-Cookie",
            "pc_" + slug + "=" + value + "; Path=/p/" + slug + "/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + COOKIE_TTL
          );
        }
        return response;
      }
    }
  }
  return unauthorized();
}
`;

// Assemble the full functions/_middleware.js source: the baked gate manifest,
// private sync manifest, cookie secret, and static logic.
export function renderAuthMiddleware(
  manifest,
  { cookieSecret = "", badge = true, syncToken = "", syncManifest = null } = {}
) {
  const gated = {};
  for (const entry of manifest || []) {
    if (!entry || !entry.slug) {
      continue;
    }
    const value = {};
    if (isValidPasswordHash(entry)) {
      value.salt = entry.salt;
      value.hash = entry.hash;
      value.iterations = entry.iterations;
    }
    if (Number.isFinite(entry.expiresAt) && entry.expiresAt > 0) {
      value.expiresAt = entry.expiresAt;
    }
    // Only gate slugs that actually need it — a password and/or an expiry.
    if (value.hash || value.expiresAt) {
      gated[entry.slug] = value;
    }
  }
  const header = [
    "// GENERATED by Pagecast — do not edit. Regenerated on every deploy.",
    "// Edge gate for /p/<slug>/ pages: expiry (410 once past expiresAt) and/or",
    "// HTTP Basic Auth (hash never served; signed cookie amortizes the check).",
    `const PAGECAST_SYNC_MANIFEST_PATH = ${JSON.stringify(PAGECAST_SYNC_MANIFEST_PATH)};`,
    `const SYNC_TOKEN = ${JSON.stringify(syncToken || "")};`,
    `const SYNC_MANIFEST = ${JSON.stringify(syncManifest || { version: 1, publications: [] })};`,
    `const PROTECTED = ${JSON.stringify(gated)};`,
    `const COOKIE_SECRET = ${JSON.stringify(cookieSecret)};`,
    `const GATE_HTML = ${JSON.stringify(renderGateHtml({ badge }))};`,
    `const EXPIRED_HTML = ${JSON.stringify(renderExpiredHtml({ badge }))};`
  ].join("\n");
  return `${header}\n\n${MIDDLEWARE_BODY}`;
}
