import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  REACTIONS,
  applyReaction,
  applyView,
  buildAccessEvent,
  emptyStats,
  parseDevice,
  recordD1View,
  refHost,
  retentionCutoff
} from "../feedback/worker.js";

test("parseDevice buckets user-agents into mobile/tablet/desktop", () => {
  assert.equal(
    parseDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E"
    ),
    "mobile"
  );
  assert.equal(
    parseDevice("Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537"),
    "mobile"
  );
  assert.equal(
    parseDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605"),
    "tablet"
  );
  assert.equal(
    parseDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605"),
    "desktop"
  );
  assert.equal(parseDevice(""), "desktop");
  assert.equal(parseDevice(undefined), "desktop");
});

test("refHost reduces referrers to a host bucket and collapses to direct", () => {
  assert.equal(refHost("https://twitter.com/some/path"), "twitter.com");
  assert.equal(refHost("https://www.google.com/"), "google.com");
  assert.equal(refHost(""), "direct");
  assert.equal(refHost(undefined), "direct");
  assert.equal(refHost("not a url"), "direct");
  // Same-origin navigation is not an external referrer.
  assert.equal(refHost("https://my.pages.dev/p/x/", "my.pages.dev"), "direct");
});

test("applyView accumulates immutably with coarse buckets", () => {
  let stats = emptyStats();
  stats = applyView(stats, { country: "us", ref: "twitter.com", device: "mobile" });
  stats = applyView(stats, { country: "US", ref: "twitter.com", device: "desktop" });
  stats = applyView(stats, {}); // missing fields fall back to XX/direct/desktop

  assert.equal(stats.views, 3);
  assert.equal(stats.countries.US, 2); // country is normalized to upper-case
  assert.equal(stats.countries.XX, 1);
  assert.equal(stats.referrers["twitter.com"], 2);
  assert.equal(stats.referrers.direct, 1);
  assert.equal(stats.devices.mobile, 1);
  assert.equal(stats.devices.desktop, 2);

  // Immutability: emptyStats() is not mutated.
  assert.equal(emptyStats().views, 0);
});

test("applyReaction only counts allowlisted emojis", () => {
  let stats = emptyStats();
  stats = applyReaction(stats, "🎉");
  stats = applyReaction(stats, "🎉");
  stats = applyReaction(stats, "👍");
  stats = applyReaction(stats, "<script>"); // ignored — not in the allowlist
  stats = applyReaction(stats, "💩"); // ignored — not in the allowlist

  assert.equal(stats.reactions["🎉"], 2);
  assert.equal(stats.reactions["👍"], 1);
  assert.equal(Object.keys(stats.reactions).length, 2);
  for (const emoji of Object.keys(stats.reactions)) {
    assert.ok(REACTIONS.includes(emoji));
  }
});

// Exercise the Worker fetch handler against an in-memory KV stub. This proves
// the view/react/stats contract without a live Cloudflare runtime.
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    }
  };
}

function fakeD1() {
  const events = [];
  const totals = new Map();
  const db = {
    events,
    totals,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          const bound = Object.create(statement);
          bound.values = values;
          return bound;
        },
        async run() {
          if (/INSERT INTO access_events/.test(sql)) {
            events.push({
              eventId: this.values[0], publicationId: this.values[1], occurredAt: this.values[2],
              visitorId: this.values[3], country: this.values[4], region: this.values[5],
              city: this.values[6], asn: this.values[7], organization: this.values[8],
              device: this.values[9], referrerHostname: this.values[10]
            });
          } else if (/INSERT INTO publication_totals/.test(sql)) {
            if (/MAX\(views, excluded\.views\)/.test(sql)) {
              totals.set(this.values[0], Math.max(totals.get(this.values[0]) || 0, Number(this.values[1]) || 0));
            } else {
              totals.set(this.values[0], (totals.get(this.values[0]) || 0) + 1);
            }
          } else if (/DELETE FROM access_events/.test(sql)) {
            const cutoff = this.values[0];
            for (let index = events.length - 1; index >= 0; index -= 1) {
              if (events[index].occurredAt < cutoff) events.splice(index, 1);
            }
          }
          return { success: true };
        },
        async all() {
          if (/publication_totals t/.test(sql)) {
            const publicationId = this.values[0] || "";
            const ids = publicationId ? [publicationId] : Array.from(totals.keys());
            return { results: ids.filter((id) => totals.has(id)).map((id) => {
              const rows = events.filter((event) => event.publicationId === id);
              return {
              publicationId: id,
              views: totals.get(id),
              uniqueVisitors: new Set(rows.map((row) => row.visitorId)).size,
              lastAccessAt: rows.map((row) => row.occurredAt).sort().at(-1)
            }; }) };
          }
          return { results: [] };
        }
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  };
  return db;
}

function viewRequest(slug, { country = "US", ua = "iPhone Mobile", referer = "" } = {}) {
  const req = new Request("https://feedback.workers.dev/api/v1/view", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "user-agent": ua,
      ...(referer ? { referer } : {})
    },
    body: JSON.stringify({ slug })
  });
  // Cloudflare exposes geo on request.cf; emulate it.
  Object.defineProperty(req, "cf", { value: { country }, configurable: true });
  return req;
}

test("worker records a view with geo/referrer/device and rejects bad slugs", async () => {
  const env = {
    PAGECAST_FEEDBACK: fakeKV(),
    PAGECAST_ANALYTICS: fakeD1(),
    PAGECAST_VISITOR_SECRET: "visitor-secret"
  };

  const ok = await worker.fetch(
    viewRequest("q3-report", { country: "GB", ua: "iPhone Mobile", referer: "https://twitter.com/x" }),
    env
  );
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);

  const stored = env.PAGECAST_ANALYTICS.events[0];
  assert.equal(stored.publicationId, "q3-report");
  assert.equal(stored.country, "GB");
  assert.equal(stored.referrerHostname, "twitter.com");
  assert.equal(stored.device, "mobile");

  const bad = await worker.fetch(viewRequest("../etc/passwd"), env);
  assert.equal(bad.status, 400);
});

test("worker react endpoint enforces the emoji allowlist", async () => {
  const env = { PAGECAST_FEEDBACK: fakeKV() };
  const make = (emoji) =>
    new Request("https://feedback.workers.dev/api/v1/react", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "plan", emoji })
    });

  const good = await worker.fetch(make("🚀"), env);
  assert.equal(good.status, 200);
  assert.equal((await good.json()).reactions["🚀"], 1);

  const evil = await worker.fetch(make("<img onerror=1>"), env);
  assert.equal(evil.status, 400);
});

test("worker stats endpoint is gated by the shared token", async () => {
  const env = {
    PAGECAST_FEEDBACK: fakeKV(),
    PAGECAST_ANALYTICS: fakeD1(),
    PAGECAST_VISITOR_SECRET: "visitor-secret",
    PAGECAST_STATS_TOKEN: "secret-123"
  };
  await worker.fetch(viewRequest("doc"), env);

  const unauth = await worker.fetch(
    new Request("https://feedback.workers.dev/api/v1/stats?slug=doc"),
    env
  );
  assert.equal(unauth.status, 401);

  const auth = await worker.fetch(
    new Request("https://feedback.workers.dev/api/v1/stats?slug=doc&token=secret-123"),
    env
  );
  assert.equal(auth.status, 200);
  const body = await auth.json();
  assert.equal(body.stats.views, 1);
});

test("worker serves the embeddable widget.js", async () => {
  const env = { PAGECAST_FEEDBACK: fakeKV() };
  const res = await worker.fetch(
    new Request("https://feedback.workers.dev/widget.js"),
    env
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
  const src = await res.text();
  assert.match(src, /api\/v1\/view/);
  assert.match(src, /data-slug/);
});

test("access events HMAC the transient IP and retain only coarse request metadata", async () => {
  const rawIp = ["203", "0", "113", "42"].join(".");
  const request = viewRequest("ignored", {
    country: "US",
    ua: "iPhone Mobile",
    referer: "https://example.com/private/document?secret=yes"
  });
  request.headers.set("CF-Connecting-IP", rawIp);
  Object.defineProperty(request, "cf", {
    value: {
      country: "US",
      region: "California",
      city: "San Francisco",
      asn: 64500,
      asOrganization: "Example Network"
    },
    configurable: true
  });

  const event = await buildAccessEvent({
    publicationId: "a".repeat(32),
    request,
    secret: "home-secret",
    now: new Date("2026-07-13T00:00:00.000Z")
  });

  assert.equal(event.publicationId, "a".repeat(32));
  assert.match(event.visitorId, /^[a-f0-9]{64}$/);
  assert.equal(event.country, "US");
  assert.equal(event.region, "California");
  assert.equal(event.city, "San Francisco");
  assert.equal(event.asn, 64500);
  assert.equal(event.organization, "Example Network");
  assert.equal(event.device, "mobile");
  assert.equal(event.referrerHost, "example.com");
  assert.equal(JSON.stringify(event).includes(rawIp), false);
  assert.equal(JSON.stringify(event).includes("/private/document"), false);
  assert.equal(JSON.stringify(event).includes("secret=yes"), false);
  assert.equal(retentionCutoff(new Date("2026-07-31T00:00:00.000Z")), "2026-07-01T00:00:00.000Z");
});

test("D1 view recording uses append-only events and atomic aggregate increments", async () => {
  const calls = [];
  let views = 0;
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              calls.push({ sql, values });
              if (/publication_totals/.test(sql)) views += 1;
              return { success: true };
            }
          };
        }
      };
    },
    async batch(statements) {
      await Promise.all(statements.map((statement) => statement.run()));
      return statements.map(() => ({ success: true }));
    }
  };
  const event = {
    eventId: "event-1",
    publicationId: "b".repeat(32),
    occurredAt: "2026-07-13T00:00:00.000Z",
    visitorId: "c".repeat(64),
    country: "US",
    region: "",
    city: "",
    asn: 64500,
    organization: "Example",
    device: "desktop",
    referrerHost: "direct"
  };

  await Promise.all(Array.from({ length: 50 }, (_, index) =>
    recordD1View(db, { ...event, eventId: `event-${index}` })
  ));

  assert.equal(views, 50);
  assert.equal(calls.filter((call) => /INSERT INTO access_events/.test(call.sql)).length, 50);
  assert.equal(calls.some((call) => JSON.stringify(call).includes("CF-Connecting-IP")), false);
});

test("legacy KV totals migrate to immutable publication totals before new D1 events", async () => {
  const kv = fakeKV();
  await kv.put("stats:old-slug", JSON.stringify({
    ...emptyStats(),
    views: 12,
    countries: { IN: 12 }
  }));
  const d1 = fakeD1();
  const env = {
    PAGECAST_FEEDBACK: kv,
    PAGECAST_ANALYTICS: d1,
    PAGECAST_STATS_TOKEN: "stats-secret",
    PAGECAST_VISITOR_SECRET: "visitor-secret"
  };
  const publicationId = "d".repeat(32);
  const migration = await worker.fetch(new Request("https://feedback.workers.dev/api/v1/analytics/migrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "stats-secret", publications: [{ publicationId, slug: "old-slug" }] })
  }), env);
  assert.equal(migration.status, 200);
  assert.equal((await migration.json()).migrated, 1);
  assert.equal(d1.totals.get(publicationId), 12);

  await worker.fetch(viewRequest(publicationId), env);
  assert.equal(d1.totals.get(publicationId), 13);
  assert.equal(d1.events.length, 1);
});
