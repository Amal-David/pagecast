import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupAnalytics, handleAnalyticsControl, handlePublicAnalyticsEvent, recordView } from "../src/analytics";
import { encodeHex, hmac, type AuthActor } from "../src/auth";
import type { Env } from "../src/types";

const ownerId = "analytics-owner";
const publicationId = "analytics-publication";
const versionId = "analytics-version";
const identity = { ownerId, publicationId, versionId };
const workerEnv = { ...env, ANALYTICS_HMAC_KEY: "analytics-key-that-is-not-a-cookie-key", COOKIE_SIGNING_KEY: "cookie-key-that-is-not-an-analytics-key" } as Env;
const owner: AuthActor = { kind: "token", ownerId, tokenId: "analytics-token", actorId: null, scopes: ["analytics:read"] };

beforeEach(async () => {
  await env.DB.exec("PRAGMA foreign_keys = ON");
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, active_version_id TEXT, link_kind TEXT NOT NULL, deleted_at TEXT, UNIQUE(owner_id, id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS analytics_events (id TEXT NOT NULL, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, event_type TEXT NOT NULL, reaction TEXT, address_hmac TEXT NOT NULL, country_code TEXT, referrer_host TEXT, device_class TEXT NOT NULL, owner_quota_limit INTEGER NOT NULL, global_quota_limit INTEGER NOT NULL, occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), expires_at TEXT NOT NULL, PRIMARY KEY(owner_id, id), FOREIGN KEY(owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS analytics_aggregates (owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, granularity TEXT NOT NULL, bucket_start TEXT NOT NULL, event_type TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, unique_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id, publication_id, granularity, bucket_start, event_type), FOREIGN KEY(owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS analytics_uniques (owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, granularity TEXT NOT NULL, bucket_start TEXT NOT NULL, event_type TEXT NOT NULL, address_hmac TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(owner_id, publication_id, granularity, bucket_start, event_type, address_hmac), FOREIGN KEY(owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS analytics_ingest_counters (owner_id TEXT NOT NULL, bucket_day TEXT NOT NULL, accepted_count INTEGER NOT NULL DEFAULT 0, limit_count INTEGER NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(owner_id, bucket_day), FOREIGN KEY(owner_id) REFERENCES owners(id) ON DELETE CASCADE)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS analytics_global_ingest_counters (bucket_day TEXT PRIMARY KEY, accepted_count INTEGER NOT NULL DEFAULT 0, limit_count INTEGER NOT NULL, expires_at TEXT NOT NULL)"),
  ]);
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS analytics_events_quota BEFORE INSERT ON analytics_events
    WHEN NOT EXISTS (SELECT 1 FROM analytics_events WHERE owner_id = NEW.owner_id AND id = NEW.id)
    BEGIN
      INSERT INTO analytics_global_ingest_counters VALUES (date('now'), 1, NEW.global_quota_limit, datetime('now', '+30 days'))
      ON CONFLICT(bucket_day) DO UPDATE SET accepted_count = accepted_count + 1, limit_count = MIN(analytics_global_ingest_counters.limit_count, NEW.global_quota_limit)
      WHERE accepted_count < MIN(analytics_global_ingest_counters.limit_count, NEW.global_quota_limit);
      SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'analytics_global_quota_exceeded') END;
      INSERT INTO analytics_ingest_counters VALUES (NEW.owner_id, date('now'), 1, NEW.owner_quota_limit, datetime('now', '+30 days'))
      ON CONFLICT(owner_id, bucket_day) DO UPDATE SET accepted_count = accepted_count + 1, limit_count = MIN(analytics_ingest_counters.limit_count, NEW.owner_quota_limit)
      WHERE accepted_count < MIN(analytics_ingest_counters.limit_count, NEW.owner_quota_limit);
      SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'analytics_owner_quota_exceeded') END;
    END`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS analytics_events_rollup AFTER INSERT ON analytics_events BEGIN
      INSERT OR IGNORE INTO analytics_uniques VALUES (NEW.owner_id, NEW.publication_id, 'hour', strftime('%Y-%m-%dT%H:00:00Z', NEW.occurred_at), NEW.event_type, NEW.address_hmac, NEW.expires_at);
      INSERT INTO analytics_aggregates VALUES (NEW.owner_id, NEW.publication_id, 'hour', strftime('%Y-%m-%dT%H:00:00Z', NEW.occurred_at), NEW.event_type, 1, changes()) ON CONFLICT(owner_id, publication_id, granularity, bucket_start, event_type) DO UPDATE SET event_count = event_count + 1, unique_count = unique_count + excluded.unique_count;
      INSERT OR IGNORE INTO analytics_uniques VALUES (NEW.owner_id, NEW.publication_id, 'day', strftime('%Y-%m-%dT00:00:00Z', NEW.occurred_at), NEW.event_type, NEW.address_hmac, NEW.expires_at);
      INSERT INTO analytics_aggregates VALUES (NEW.owner_id, NEW.publication_id, 'day', strftime('%Y-%m-%dT00:00:00Z', NEW.occurred_at), NEW.event_type, 1, changes()) ON CONFLICT(owner_id, publication_id, granularity, bucket_start, event_type) DO UPDATE SET event_count = event_count + 1, unique_count = unique_count + excluded.unique_count;
    END`).run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM analytics_events WHERE owner_id = ?").bind(ownerId),
    env.DB.prepare("DELETE FROM analytics_uniques WHERE owner_id = ?").bind(ownerId),
    env.DB.prepare("DELETE FROM analytics_aggregates WHERE owner_id = ?").bind(ownerId),
    env.DB.prepare("DELETE FROM analytics_ingest_counters WHERE owner_id = ?").bind(ownerId),
    env.DB.prepare("DELETE FROM analytics_global_ingest_counters"),
    env.DB.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId),
    env.DB.prepare("INSERT OR IGNORE INTO publications (id, owner_id, slug, title, state, active_version_id, link_kind) VALUES (?, ?, ?, ?, 'published', ?, 'public')").bind(publicationId, ownerId, "analytics-publication", "Analytics publication", versionId),
  ]);
});

describe("privacy-preserving analytics", () => {
  it("rejects hostile public payloads and limits CORS to the anonymous event endpoint", async () => {
    const options = await handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/analytics-publication/_analytics/events", { method: "OPTIONS", headers: { Origin: "https://viewer.example" } }), workerEnv, identity);
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const hostile = await handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/analytics-publication/_analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "event-id-with-enough-length", type: "share", address: "198.51.100.44" }) }), workerEnv, identity);
    expect(hostile.status).toBe(400);
    const hostileReaction = await handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/analytics-publication/_analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "event-id-with-enough-length", type: "reaction", reaction: "<script>" }) }), workerEnv, identity);
    expect(hostileReaction.status).toBe(400);
  });

  it("stores only a dedicated HMAC and coarse allowlisted dimensions", async () => {
    const address = "198.51.100.44";
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": address, "CF-IPCountry": "US", Referer: "https://referrer.example/a/private?token=nope", "User-Agent": "Mozilla/5.0 (iPhone; Mobile)" } }), workerEnv, identity);
    const event = await env.DB.prepare("SELECT address_hmac, country_code, referrer_host, device_class FROM analytics_events WHERE owner_id = ?").bind(ownerId).first<{ address_hmac: string; country_code: string; referrer_host: string; device_class: string }>();
    expect(event).toEqual({ address_hmac: await encodeHex(await hmac(workerEnv.ANALYTICS_HMAC_KEY, `analytics-address-v1:${address}`)), country_code: "US", referrer_host: "referrer.example", device_class: "mobile" });
    expect(event!.address_hmac).not.toContain(address);
    expect(event!.address_hmac).not.toBe(await encodeHex(await hmac(workerEnv.COOKIE_SIGNING_KEY, `analytics-address-v1:${address}`)));
  });

  it("deduplicates retries before trigger-backed event and unique aggregate rollups", async () => {
    const ctx = createExecutionContext();
    const request = () => new Request("https://pagecast.test/p/analytics-publication/_analytics/events", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ eventId: "deduplicated-event-id-0001", type: "reaction", reaction: "love" }) });
    expect((await handlePublicAnalyticsEvent(request(), workerEnv, identity, ctx)).status).toBe(202);
    expect((await handlePublicAnalyticsEvent(request(), workerEnv, identity, ctx)).status).toBe(202);
    await waitOnExecutionContext(ctx);
    const events = await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE owner_id = ?").bind(ownerId).first<{ count: number }>();
    const aggregate = await env.DB.prepare("SELECT event_count, unique_count FROM analytics_aggregates WHERE owner_id = ? AND event_type = 'reaction' AND granularity = 'day'").bind(ownerId).first<{ event_count: number; unique_count: number }>();
    expect(events?.count).toBe(1);
    expect(aggregate).toEqual({ event_count: 1, unique_count: 1 });
  });

  it("does not charge duplicate beacons against an owner cap", async () => {
    const limitedEnv = { ...workerEnv, ANALYTICS_DAILY_EVENT_LIMIT: "1" } as Env;
    const ctx = createExecutionContext();
    const beacon = (eventId: string) => handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/analytics-publication/_analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId, type: "share" }) }), limitedEnv, identity, ctx);
    expect((await beacon("analytics-cap-event-00001")).status).toBe(202);
    expect((await beacon("analytics-cap-event-00001")).status).toBe(202);
    expect((await beacon("analytics-cap-event-00002")).status).toBe(202);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE owner_id = ?").bind(ownerId).first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT accepted_count FROM analytics_ingest_counters WHERE owner_id = ?").bind(ownerId).first<{ accepted_count: number }>())?.accepted_count).toBe(1);
  });

  it("caps anonymous ingest across the account as well as per owner", async () => {
    const secondOwner = "analytics-global-cap-owner";
    const secondPublication = "analytics-global-cap-publication";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(secondOwner),
      env.DB.prepare("INSERT INTO publications (id, owner_id, slug, title, state, active_version_id, link_kind) VALUES (?, ?, ?, ?, 'published', ?, 'public')").bind(secondPublication, secondOwner, "analytics-global-cap-publication", "Global cap", "analytics-global-cap-version"),
    ]);
    const limitedEnv = { ...workerEnv, ANALYTICS_DAILY_EVENT_LIMIT: "3", ANALYTICS_GLOBAL_DAILY_EVENT_LIMIT: "1" } as Env;
    const ctx = createExecutionContext();
    const beacon = (target: typeof identity, eventId: string) => handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/x/_analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId, type: "share" }) }), limitedEnv, target, ctx);
    await beacon(identity, "analytics-global-cap-event-01");
    await beacon({ ownerId: secondOwner, publicationId: secondPublication, versionId: "analytics-global-cap-version" }, "analytics-global-cap-event-02");
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT accepted_count FROM analytics_global_ingest_counters").first<{ accepted_count: number }>())?.accepted_count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_events").first<{ count: number }>())?.count).toBe(1);
    expect(await env.DB.prepare("SELECT accepted_count FROM analytics_ingest_counters WHERE owner_id = ?").bind(secondOwner).first()).toBeNull();
  });

  it("HMACs client event IDs per owner and cascades all HMAC-bearing rows with a publication", async () => {
    const secondOwner = "analytics-owner-second";
    const secondPublication = "analytics-publication-second";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(secondOwner),
      env.DB.prepare("INSERT INTO publications (id, owner_id, slug, title, state, active_version_id, link_kind) VALUES (?, ?, ?, ?, 'published', ?, 'public')").bind(secondPublication, secondOwner, "analytics-publication-second", "Second", "analytics-version-second"),
    ]);
    const ctx = createExecutionContext();
    const eventId = "shared-event-id-across-owners";
    const beacon = (target: typeof identity) => handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/x/_analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId, type: "reaction", reaction: "like" }) }), workerEnv, target, ctx);
    expect((await beacon(identity)).status).toBe(202);
    expect((await beacon({ ownerId: secondOwner, publicationId: secondPublication, versionId: "analytics-version-second" })).status).toBe(202);
    await waitOnExecutionContext(ctx);
    const stored = await env.DB.prepare("SELECT id FROM analytics_events WHERE id != ? ORDER BY owner_id").bind(eventId).all<{ id: string }>();
    expect(stored.results).toHaveLength(2);
    expect(new Set(stored.results.map((row) => row.id)).size).toBe(2);
    expect(stored.results.every((row) => row.id !== eventId)).toBe(true);
    const events = await handleAnalyticsControl(new Request(`https://pagecast.test/v1/owners/${ownerId}/analytics/events?publicationId=${publicationId}`), workerEnv, new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/events?publicationId=${publicationId}`), owner);
    expect(await events?.text()).not.toContain(eventId);
    await env.DB.prepare("DELETE FROM publications WHERE owner_id = ? AND id = ?").bind(ownerId, publicationId).run();
    for (const table of ["analytics_events", "analytics_aggregates", "analytics_uniques"]) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ? AND publication_id = ?`).bind(ownerId, publicationId).first<{ count: number }>())?.count).toBe(0);
    }
  });

  it("counts one publication visitor across version changes in the same day", async () => {
    const viewer = { "CF-Connecting-IP": "203.0.113.77" };
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: viewer }), workerEnv, identity);
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: viewer }), workerEnv, { ...identity, versionId: "analytics-version-next" });

    const aggregate = await env.DB.prepare("SELECT event_count, unique_count FROM analytics_aggregates WHERE owner_id = ? AND publication_id = ? AND event_type = 'view' AND granularity = 'day'")
      .bind(ownerId, publicationId)
      .first<{ event_count: number; unique_count: number }>();
    expect(aggregate).toEqual({ event_count: 2, unique_count: 1 });
  });

  it("reports redacted, owner-scoped aggregates and event pages without visitor identifiers", async () => {
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": "203.0.113.10" } }), workerEnv, identity);
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": "203.0.113.10" } }), workerEnv, identity);
    const summary = await handleAnalyticsControl(new Request(`https://pagecast.test/v1/owners/${ownerId}/analytics/summary?publicationId=${publicationId}`), workerEnv, new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/summary?publicationId=${publicationId}`), owner);
    expect(summary?.status).toBe(200);
    expect(await summary?.json()).toMatchObject({ totals: { views: 2 }, uniqueVisitorsDailySum: 1, uniqueVisitorSemantics: "sum_of_daily_unique_viewers" });
    const events = await handleAnalyticsControl(new Request(`https://pagecast.test/v1/owners/${ownerId}/analytics/events?publicationId=${publicationId}`), workerEnv, new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/events?publicationId=${publicationId}`), owner);
    const body = await events?.text() ?? "";
    expect(body).not.toContain("address_hmac");
    expect(body).not.toContain("203.0.113.10");
    expect((await handleAnalyticsControl(new Request(`https://pagecast.test/v1/owners/other-owner/analytics/summary?publicationId=${publicationId}`), workerEnv, new URL(`https://pagecast.test/v1/owners/other-owner/analytics/summary?publicationId=${publicationId}`), owner))?.status).toBe(403);
  });

  it("reports a bounded sum of daily uniques instead of scanning retained event identities", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO analytics_aggregates VALUES (?, ?, 'day', ?, 'view', 1, 1)").bind(ownerId, publicationId, yesterday.toISOString().replace(".000", "")),
      env.DB.prepare("INSERT INTO analytics_aggregates VALUES (?, ?, 'day', ?, 'view', 1, 1)").bind(ownerId, publicationId, today.toISOString().replace(".000", "")),
    ]);
    const url = new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/summary?publicationId=${publicationId}&from=${encodeURIComponent(yesterday.toISOString())}&to=${encodeURIComponent(tomorrow.toISOString())}`);
    const summary = await handleAnalyticsControl(new Request(url), workerEnv, url, owner);
    expect(await summary?.json()).toMatchObject({ uniqueVisitorsDailySum: 2, uniqueVisitorSemantics: "sum_of_daily_unique_viewers" });
  });

  it("normalizes bounded UTC ranges and counts retained view identities exactly across days", async () => {
    const address = "203.0.113.101";
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": address } }), workerEnv, identity);
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": address } }), workerEnv, identity);
    await env.DB.prepare("UPDATE analytics_events SET occurred_at = datetime('now', '-1 day') WHERE owner_id = ? AND id = (SELECT MIN(id) FROM analytics_events WHERE owner_id = ?)").bind(ownerId, ownerId).run();
    const normalizedUrl = new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/summary?publicationId=${publicationId}&from=2026-01-01T05:30:00%2B05:30&to=2026-01-02T05:30:00%2B05:30`);
    const normalized = await handleAnalyticsControl(new Request(normalizedUrl), workerEnv, normalizedUrl, owner);
    expect(await normalized?.json()).toMatchObject({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" });
    const summaryUrl = new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/summary?publicationId=${publicationId}`);
    expect(await (await handleAnalyticsControl(new Request(summaryUrl), workerEnv, summaryUrl, owner))?.json()).toMatchObject({ uniqueVisitorsDailySum: 1, uniqueVisitorSemantics: "sum_of_daily_unique_viewers" });
    const overspan = new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/timeseries?publicationId=${publicationId}&from=2026-01-01T00:00:00Z&to=2026-02-02T00:00:00Z`);
    expect((await handleAnalyticsControl(new Request(overspan), workerEnv, overspan, owner))?.status).toBe(400);
  });

  it("stores canonical UTC event timestamps that fall inside same-day ISO ranges", async () => {
    await recordView(new Request("https://pagecast.test/p/analytics-publication/"), workerEnv, identity);
    const event = await env.DB.prepare("SELECT occurred_at FROM analytics_events WHERE owner_id = ?").bind(ownerId).first<{ occurred_at: string }>();
    expect(event?.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const start = new Date(event!.occurred_at);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);
    const url = new URL(`https://pagecast.test/v1/owners/${ownerId}/analytics/events?publicationId=${publicationId}&from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
    const response = await handleAnalyticsControl(new Request(url), workerEnv, url, owner);
    expect((await response?.json() as { events: unknown[] }).events).toHaveLength(1);
  });

  it("removes expired detailed identities and events while retaining aggregate history", async () => {
    await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": "203.0.113.18" } }), workerEnv, identity);
    await env.DB.prepare("UPDATE analytics_events SET expires_at = datetime('now', '-1 second') WHERE owner_id = ?").bind(ownerId).run();
    await env.DB.prepare("UPDATE analytics_uniques SET expires_at = datetime('now', '-1 second') WHERE owner_id = ?").bind(ownerId).run();
    await cleanupAnalytics(env.DB);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE owner_id = ?").bind(ownerId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_uniques WHERE owner_id = ?").bind(ownerId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT SUM(event_count) AS count FROM analytics_aggregates WHERE owner_id = ? AND granularity = 'day'").bind(ownerId).first<{ count: number }>())?.count).toBe(1);
  });

  it("uses at most fifty cleanup rows per analytics table per run", async () => {
    for (let index = 0; index < 51; index += 1) {
      await recordView(new Request("https://pagecast.test/p/analytics-publication/", { headers: { "CF-Connecting-IP": `203.0.113.${index}` } }), workerEnv, identity);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE analytics_events SET expires_at = datetime('now', '-1 second') WHERE owner_id = ?").bind(ownerId),
      env.DB.prepare("UPDATE analytics_uniques SET expires_at = datetime('now', '-1 second') WHERE owner_id = ?").bind(ownerId),
    ]);
    await cleanupAnalytics(env.DB);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE owner_id = ?").bind(ownerId).first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_uniques WHERE owner_id = ?").bind(ownerId).first<{ count: number }>())?.count).toBeGreaterThan(0);
  });

  it("contains failed asynchronous analytics writes so delivery can continue", async () => {
    const ctx = createExecutionContext();
    const failing = { ...workerEnv, DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
    const response = await handlePublicAnalyticsEvent(new Request("https://pagecast.test/p/analytics-publication/_analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "write-failure-event-0001", type: "share" }) }), failing, identity, ctx);
    expect(response.status).toBe(202);
    await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
  });
});
