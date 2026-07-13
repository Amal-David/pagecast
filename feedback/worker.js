// Pagecast feedback Worker.
//
// One small Cloudflare Worker, deployed once to the user's own account, that
// backs every published page's reactions + view analytics. Published static
// pages embed `widget.js` (served from this Worker); the widget beacons a view
// and posts reactions here, and the Pagecast admin reads aggregate stats back.
//
// Storage: append-only access events and atomic per-publication totals live in
// D1 (binding PAGECAST_ANALYTICS). The older KV aggregate remains readable for
// compatibility and reactions, but is no longer used for view writes.
//
// Privacy: only coarse, aggregate signals are stored — country (from Cloudflare's
// request.cf), referrer HOST (not full URL), and device class. A connecting IP
// is HMACed immediately with a per-Home secret and the raw value is discarded.
// No cookies, raw IP persistence, or named visitor identity.
//
// The pure helpers below are exported so they can be unit-tested under Node
// without a Workers runtime (see test/feedback.test.js).

// The reactions a viewer can leave. Anything outside this allowlist is ignored,
// so the endpoint can't be used to store arbitrary attacker-controlled strings.
export const REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"];

export function emptyStats() {
  return { views: 0, reactions: {}, countries: {}, referrers: {}, devices: {} };
}

// Coarse device class from a User-Agent string. Intentionally simple — we only
// want mobile / tablet / desktop buckets, not fingerprinting.
export function parseDevice(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

// Reduce a referrer to a host bucket. Unknown / same-origin / missing referrers
// collapse to "direct" so the breakdown stays meaningful.
export function refHost(referrer, selfHost = "") {
  const raw = String(referrer || "").trim();
  if (raw === "") {
    return "direct";
  }
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return "direct";
  }
  if (!host || (selfHost && host === String(selfHost).toLowerCase())) {
    return "direct";
  }
  // Drop a leading www. so example.com and www.example.com aggregate together.
  return host.replace(/^www\./, "");
}

function cleanText(value, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanPublicationId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,128}$/.test(id) ? id : null;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function retentionCutoff(now = new Date()) {
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

export async function hashVisitor(rawIp, secret) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("Web Crypto is required for visitor hashing.");
  const encoder = new TextEncoder();
  const key = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await cryptoApi.subtle.sign("HMAC", key, encoder.encode(String(rawIp || "unknown"))));
}

export async function buildAccessEvent({ publicationId, request, secret, now = new Date() }) {
  const cf = request.cf || {};
  // Read once, hash immediately, and never put the raw address on the event.
  const visitorId = await hashVisitor(request.headers.get("CF-Connecting-IP") || "unknown", secret);
  return {
    eventId: globalThis.crypto.randomUUID(),
    publicationId: cleanPublicationId(publicationId),
    occurredAt: now.toISOString(),
    visitorId,
    country: cleanText(cf.country || "XX", 2).toUpperCase(),
    region: cleanText(cf.region),
    city: cleanText(cf.city),
    asn: Number.isFinite(Number(cf.asn)) ? Number(cf.asn) : null,
    organization: cleanText(cf.asOrganization),
    device: parseDevice(request.headers.get("user-agent")),
    referrerHost: refHost(request.headers.get("referer"), new URL(request.url).hostname)
  };
}

export async function recordD1View(db, event) {
  const insert = db.prepare(
    "INSERT INTO access_events (event_id, publication_id, occurred_at, visitor_id, country, region, city, asn, organization, device, referrer_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    event.eventId,
    event.publicationId,
    event.occurredAt,
    event.visitorId,
    event.country,
    event.region,
    event.city,
    event.asn,
    event.organization,
    event.device,
    event.referrerHost
  );
  const aggregate = db.prepare(
    "INSERT INTO publication_totals (publication_id, views, last_access_at) VALUES (?, 1, ?) ON CONFLICT(publication_id) DO UPDATE SET views = views + 1, last_access_at = excluded.last_access_at"
  ).bind(event.publicationId, event.occurredAt);
  await db.batch([insert, aggregate]);
}

async function pruneDetailedEvents(db, now = new Date()) {
  await db.prepare("DELETE FROM access_events WHERE occurred_at < ?").bind(retentionCutoff(now)).run();
}

async function readD1Summary(db, publicationId = "") {
  const filter = publicationId ? "WHERE t.publication_id = ?" : "";
  const statement = db.prepare(
    `SELECT t.publication_id AS publicationId, t.views AS views, COUNT(DISTINCT e.visitor_id) AS uniqueVisitors, t.last_access_at AS lastAccessAt FROM publication_totals t LEFT JOIN access_events e ON e.publication_id = t.publication_id ${filter} GROUP BY t.publication_id ORDER BY lastAccessAt DESC`
  );
  const result = publicationId ? await statement.bind(publicationId).all() : await statement.all();
  return result.results || [];
}

async function readD1Events(db, publicationId = "", cursor = "", limit = 50) {
  const filters = [];
  const values = [];
  if (publicationId) {
    filters.push("publication_id = ?");
    values.push(publicationId);
  }
  if (cursor) {
    filters.push("occurred_at < ?");
    values.push(cursor);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const statement = db.prepare(
    `SELECT event_id AS eventId, publication_id AS publicationId, occurred_at AS occurredAt, visitor_id AS visitorId, country, region, city, asn, organization, device, referrer_host AS referrerHostname FROM access_events ${where} ORDER BY occurred_at DESC LIMIT ?`
  ).bind(...values, limit + 1);
  const result = await statement.all();
  const rows = result.results || [];
  return {
    events: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1]?.occurredAt || "" : ""
  };
}

function bump(map, key) {
  const k = key || "unknown";
  return { ...map, [k]: (map[k] || 0) + 1 };
}

// Apply a single view to an aggregate, returning a new aggregate.
export function applyView(stats, { country, ref, device } = {}) {
  const base = stats || emptyStats();
  return {
    ...base,
    views: (base.views || 0) + 1,
    countries: bump(base.countries || {}, (country || "XX").toUpperCase()),
    referrers: bump(base.referrers || {}, ref || "direct"),
    devices: bump(base.devices || {}, device || "desktop")
  };
}

// Apply a single reaction. Non-allowlisted emojis are ignored (returns the
// aggregate unchanged) so the store can't be polluted.
export function applyReaction(stats, emoji) {
  const base = stats || emptyStats();
  if (!REACTIONS.includes(emoji)) {
    return base;
  }
  return { ...base, reactions: bump(base.reactions || {}, emoji) };
}

// --- Worker runtime --------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders }
  });
}

// Slugs come from the embedding page; keep them tame so they can't be abused as
// KV key injection or unbounded cardinality.
function cleanSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,128}$/.test(slug) ? slug : null;
}

async function readStats(env, slug) {
  const raw = await env.PAGECAST_FEEDBACK.get(`stats:${slug}`);
  if (!raw) return emptyStats();
  try {
    return { ...emptyStats(), ...JSON.parse(raw) };
  } catch {
    return emptyStats();
  }
}

async function writeStats(env, slug, stats) {
  await env.PAGECAST_FEEDBACK.put(`stats:${slug}`, JSON.stringify(stats));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // widget.js — the client script every published page embeds.
    if (request.method === "GET" && url.pathname === "/widget.js") {
      return new Response(WIDGET_SOURCE, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          ...CORS
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/view") {
      const body = await request.json().catch(() => ({}));
      const publicationId = cleanPublicationId(body.publicationId || body.slug);
      if (!publicationId) return json({ ok: false, error: "bad publication" }, 400);
      if (!env.PAGECAST_ANALYTICS || !env.PAGECAST_VISITOR_SECRET) {
        return json({ ok: false, error: "analytics unavailable" }, 503);
      }
      const event = await buildAccessEvent({
        publicationId,
        request,
        secret: env.PAGECAST_VISITOR_SECRET
      });
      await recordD1View(env.PAGECAST_ANALYTICS, event);
      await pruneDetailedEvents(env.PAGECAST_ANALYTICS).catch(() => {});
      const legacy = env.PAGECAST_FEEDBACK ? await readStats(env, cleanSlug(body.slug) || publicationId) : emptyStats();
      return json({ ok: true, reactions: legacy.reactions });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/react") {
      const body = await request.json().catch(() => ({}));
      const slug = cleanSlug(body.slug);
      if (!slug) return json({ ok: false, error: "bad slug" }, 400);
      if (!REACTIONS.includes(body.emoji)) {
        return json({ ok: false, error: "bad emoji" }, 400);
      }
      if (!env.PAGECAST_FEEDBACK) return json({ ok: false, error: "reactions unavailable" }, 409);
      const stats = applyReaction(await readStats(env, slug), body.emoji);
      await writeStats(env, slug, stats);
      return json({ ok: true, reactions: stats.reactions });
    }

    // Aggregate stats for the admin. Gated by a shared secret so a page's slug
    // alone doesn't expose its analytics to the public.
    if (request.method === "GET" && url.pathname === "/api/v1/stats") {
      const token = env.PAGECAST_STATS_TOKEN;
      if (token && url.searchParams.get("token") !== token) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const publicationId = cleanPublicationId(
        url.searchParams.get("publicationId") || url.searchParams.get("slug")
      );
      if (!publicationId) return json({ ok: false, error: "bad publication" }, 400);
      const summaries = env.PAGECAST_ANALYTICS
        ? await readD1Summary(env.PAGECAST_ANALYTICS, publicationId)
        : [];
      const legacy = env.PAGECAST_FEEDBACK
        ? await readStats(env, cleanSlug(url.searchParams.get("slug")) || publicationId)
        : emptyStats();
      const summary = summaries[0] || { publicationId, views: 0, uniqueVisitors: 0, lastAccessAt: null };
      return json({
        ok: true,
        publicationId,
        stats: { ...legacy, views: Number(summary.views || 0), uniqueVisitors: Number(summary.uniqueVisitors || 0), lastAccessAt: summary.lastAccessAt || null }
      });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/analytics/summary") {
      const token = env.PAGECAST_STATS_TOKEN;
      if (token && url.searchParams.get("token") !== token) return json({ ok: false, error: "unauthorized" }, 401);
      if (!env.PAGECAST_ANALYTICS) return json({ ok: true, summaries: [] });
      const publicationId = cleanPublicationId(url.searchParams.get("publicationId")) || "";
      return json({ ok: true, summaries: await readD1Summary(env.PAGECAST_ANALYTICS, publicationId) });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/analytics/events") {
      const token = env.PAGECAST_STATS_TOKEN;
      if (token && url.searchParams.get("token") !== token) return json({ ok: false, error: "unauthorized" }, 401);
      if (!env.PAGECAST_ANALYTICS) return json({ ok: true, events: [], nextCursor: "" });
      const publicationId = cleanPublicationId(url.searchParams.get("publicationId")) || "";
      const cursor = cleanText(url.searchParams.get("cursor"), 64);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
      return json({ ok: true, ...(await readD1Events(env.PAGECAST_ANALYTICS, publicationId, cursor, limit)) });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/analytics/migrate") {
      const body = await request.json().catch(() => ({}));
      if (env.PAGECAST_STATS_TOKEN && body.token !== env.PAGECAST_STATS_TOKEN) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      if (!env.PAGECAST_ANALYTICS || !env.PAGECAST_FEEDBACK) {
        return json({ ok: true, migrated: 0 });
      }
      let migrated = 0;
      for (const item of Array.isArray(body.publications) ? body.publications.slice(0, 5000) : []) {
        const publicationId = cleanPublicationId(item.publicationId);
        const slug = cleanSlug(item.slug);
        if (!publicationId || !slug) continue;
        const legacy = await readStats(env, slug);
        if (Number(legacy.views || 0) <= 0) continue;
        await env.PAGECAST_ANALYTICS.prepare(
          "INSERT INTO publication_totals (publication_id, views, last_access_at) VALUES (?, ?, NULL) ON CONFLICT(publication_id) DO UPDATE SET views = MAX(views, excluded.views)"
        ).bind(publicationId, Number(legacy.views)).run();
        migrated += 1;
      }
      return json({ ok: true, migrated });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
};

// The client widget is written as a real function and serialized with
// toString(), so the Worker stays a single self-contained file (no bundler
// needed at deploy time) while the widget remains readable, lint-able source.
const WIDGET_SOURCE = `(${clientWidget.toString()})();`;

function clientWidget() {
  // NOTE: this function is serialized to a string and shipped to browsers, so it
  // must not reference anything outside its own scope (no imports, no closures).
  var s = document.currentScript;
  var base = s ? s.src.replace(/\/widget\.js.*$/, "") : "";
  var slug = (s && s.getAttribute("data-slug")) || "";
  var publicationId = (s && s.getAttribute("data-publication")) || slug;
  var reactionsEnabled = Boolean(s && s.getAttribute("data-reactions") === "true");
  if (!publicationId) return;
  var REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"];

  function post(path, body) {
    return fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true
    }).then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  var counts = {};
  function render(bar) {
    bar.innerHTML = "";
    REACTIONS.forEach(function (emoji) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = emoji + (counts[emoji] ? " " + counts[emoji] : "");
      b.style.cssText =
        "font:14px system-ui;border:1px solid #e4e4e7;background:#fff;border-radius:999px;padding:4px 10px;cursor:pointer;line-height:1";
      b.onclick = function () {
        post("/api/v1/react", { slug: slug, emoji: emoji }).then(function (d) {
          if (d && d.reactions) { counts = d.reactions; render(bar); }
        });
      };
      bar.appendChild(b);
    });
  }

  var wrap = null;
  if (reactionsEnabled) {
    wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;right:16px;bottom:16px;display:flex;gap:6px;padding:6px;background:#fafafa;border:1px solid #e4e4e7;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.08);z-index:2147483647";
    render(wrap);
    document.body.appendChild(wrap);
  }

  post("/api/v1/view", { publicationId: publicationId, slug: slug }).then(function (d) {
    if (wrap && d && d.reactions) { counts = d.reactions; render(wrap); }
  });
}
