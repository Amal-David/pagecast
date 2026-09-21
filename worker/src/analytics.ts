import { encodeHex, hmac, type AuthActor } from "./auth";
import { readBoundedTextBody } from "./body";
import { isPagecastId } from "./identifiers";
import type { Env } from "./types";

const EVENT_TYPES = new Set(["view", "download", "share", "access_denied", "reaction"]);
const PUBLIC_EVENT_TYPES = new Set(["download", "share", "reaction"]);
const REACTIONS = new Set(["like", "love", "insightful", "celebrate"]);
const MAX_EVENT_BODY_BYTES = 1024;
const MAX_ANALYTICS_RANGE_MS = 31 * 86_400_000;
const MAX_TIME_SERIES_POINTS = 31 * 24 * 5;
// A 15-minute cleanup removes at most 50 rows/table, or 4,800 rows/day.
// Each event can create two unique rows, so the account cap leaves drain headroom.
const DEFAULT_OWNER_DAILY_EVENT_LIMIT = 1_000;
const MAX_OWNER_DAILY_EVENT_LIMIT = 1_000;
const DEFAULT_GLOBAL_DAILY_EVENT_LIMIT = 2_000;
const MAX_GLOBAL_DAILY_EVENT_LIMIT = 2_000;

export interface PublicationAnalyticsIdentity {
  ownerId: string;
  publicationId: string;
  versionId: string;
}

type AnalyticsEventType = "view" | "download" | "share" | "access_denied" | "reaction";
type DeviceClass = "desktop" | "mobile" | "tablet" | "unknown";

interface PublicEventPayload {
  eventId: string;
  type: "download" | "share" | "reaction";
  reaction: "like" | "love" | "insightful" | "celebrate" | null;
}

interface AggregateRow {
  event_type: AnalyticsEventType;
  event_count: number;
  unique_count: number;
}

interface EventRow {
  id: string;
  publication_id: string;
  version_id: string;
  event_type: AnalyticsEventType;
  reaction: string | null;
  country_code: string | null;
  referrer_host: string | null;
  device_class: DeviceClass;
  occurred_at: string;
}

interface TimeSeriesRow extends AggregateRow { bucket_start: string; }

export function scheduleAnalytics(ctx: Pick<ExecutionContext, "waitUntil"> | undefined, operation: Promise<unknown>): void {
  const safe = operation.catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(safe);
}

export function recordView(request: Request, env: Env, identity: PublicationAnalyticsIdentity): Promise<void> {
  return recordEvent(request, env, identity, { id: crypto.randomUUID(), type: "view", reaction: null });
}

export function recordAccessDenied(request: Request, env: Env, identity: PublicationAnalyticsIdentity): Promise<void> {
  return recordEvent(request, env, identity, { id: crypto.randomUUID(), type: "access_denied", reaction: null });
}

export async function handlePublicAnalyticsEvent(
  request: Request,
  env: Env,
  identity: PublicationAnalyticsIdentity,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: publicCorsHeaders() });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...publicCorsHeaders(), Allow: "POST, OPTIONS" } });
  const payload = await parsePublicPayload(request);
  if (!payload) return Response.json({ error: "invalid_analytics_event" }, { status: 400, headers: publicCorsHeaders() });
  scheduleAnalytics(ctx, recordEvent(request, env, identity, { id: payload.eventId, type: payload.type, reaction: payload.reaction }));
  return new Response(null, { status: 202, headers: publicCorsHeaders() });
}

export async function handleAnalyticsControl(request: Request, env: Env, url: URL, actor: AuthActor): Promise<Response | null> {
  const match = /^\/v1\/owners\/([^/]+)\/analytics\/(summary|timeseries|events)$/.exec(url.pathname);
  if (!match) return null;
  const [, ownerId, resource] = match;
  if (!ownerOwns(actor, ownerId) || !hasAnalyticsScope(actor) || request.method !== "GET") return Response.json({ error: "forbidden" }, { status: 403 });
  const publicationId = url.searchParams.get("publicationId");
  if (!isPagecastId(publicationId)) return Response.json({ error: "publication_id_required" }, { status: 400 });
  const publication = await env.DB.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first();
  if (!publication) return Response.json({ error: "publication_not_found" }, { status: 404 });
  if (resource === "summary") return summary(env.DB, ownerId, publicationId, url);
  if (resource === "timeseries") return timeSeries(env.DB, ownerId, publicationId, url);
  return redactedEvents(env.DB, ownerId, publicationId, url);
}

export async function cleanupAnalytics(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM analytics_events WHERE rowid IN (SELECT rowid FROM analytics_events WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 50)").run();
  await db.prepare("DELETE FROM analytics_uniques WHERE rowid IN (SELECT rowid FROM analytics_uniques WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 50)").run();
  await db.prepare("DELETE FROM analytics_ingest_counters WHERE rowid IN (SELECT rowid FROM analytics_ingest_counters WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 50)").run();
  await db.prepare("DELETE FROM analytics_global_ingest_counters WHERE rowid IN (SELECT rowid FROM analytics_global_ingest_counters WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 50)").run();
}

async function recordEvent(
  request: Request,
  env: Env,
  identity: PublicationAnalyticsIdentity,
  event: { id: string; type: AnalyticsEventType; reaction: string | null },
): Promise<void> {
  if (!EVENT_TYPES.has(event.type) || !isPagecastId(identity.ownerId) || !isPagecastId(identity.publicationId) || !isPagecastId(identity.versionId)) return;
  const visitorId = await visitorHmac(env.ANALYTICS_HMAC_KEY, request.headers.get("CF-Connecting-IP"));
  const storedEventId = await eventIdHmac(env.ANALYTICS_HMAC_KEY, identity.ownerId, event.id);
  try {
    await env.DB.prepare(`INSERT OR IGNORE INTO analytics_events
      (id, owner_id, publication_id, version_id, event_type, reaction, address_hmac, country_code, referrer_host, device_class, owner_quota_limit, global_quota_limit, occurred_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+30 days'))`)
      .bind(storedEventId, identity.ownerId, identity.publicationId, identity.versionId, event.type, event.reaction, visitorId, coarseCountry(request), referrerHost(request), deviceClass(request), ownerDailyEventLimit(env), globalDailyEventLimit(env))
      .run();
  } catch (error) {
    if (isQuotaExceeded(error)) return;
    throw error;
  }
}

async function visitorHmac(key: string, address: string | null): Promise<string> {
  return encodeHex(await hmac(key, `analytics-address-v1:${address ?? "unknown"}`));
}

async function eventIdHmac(key: string, ownerId: string, eventId: string): Promise<string> {
  return encodeHex(await hmac(key, `analytics-event-v1:${ownerId}:${eventId}`));
}

function coarseCountry(request: Request): string | null {
  const value = request.headers.get("CF-IPCountry")?.toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

function referrerHost(request: Request): string | null {
  const raw = request.headers.get("Referer");
  if (!raw || raw.length > 2048) return null;
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) && !hostname.includes("..") ? hostname : null;
  } catch {
    return null;
  }
}

function deviceClass(request: Request): DeviceClass {
  const value = request.headers.get("User-Agent")?.toLowerCase() ?? "";
  if (!value || value.length > 1024) return "unknown";
  if (/(ipad|tablet|kindle|silk)/.test(value)) return "tablet";
  if (/(mobile|iphone|android)/.test(value)) return "mobile";
  return /(mozilla|chrome|safari|firefox|edge)/.test(value) ? "desktop" : "unknown";
}

async function parsePublicPayload(request: Request): Promise<PublicEventPayload | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return null;
  const body = await readBoundedTextBody(request, MAX_EVENT_BODY_BYTES);
  if ("tooLarge" in body) return null;
  try {
    const value: unknown = JSON.parse(body.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (!sameKeys(payload, ["eventId", "type"], ["reaction"]) || typeof payload.eventId !== "string" || typeof payload.type !== "string") return null;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(payload.eventId) || !PUBLIC_EVENT_TYPES.has(payload.type)) return null;
    if (payload.type === "reaction") return typeof payload.reaction === "string" && REACTIONS.has(payload.reaction) ? { eventId: payload.eventId, type: "reaction", reaction: payload.reaction as PublicEventPayload["reaction"] } : null;
    return payload.reaction === undefined ? { eventId: payload.eventId, type: payload.type as PublicEventPayload["type"], reaction: null } : null;
  } catch {
    return null;
  }
}

function sameKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function publicCorsHeaders(): Record<string, string> {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}

async function summary(db: D1Database, ownerId: string, publicationId: string, url: URL): Promise<Response> {
  const range = dateRange(url);
  if (!range) return Response.json({ error: "invalid_date_range" }, { status: 400 });
  const result = await db.prepare(`SELECT event_type, SUM(event_count) AS event_count, SUM(unique_count) AS unique_count
    FROM analytics_aggregates WHERE owner_id = ? AND publication_id = ? AND granularity = 'day' AND bucket_start >= ? AND bucket_start < ? GROUP BY event_type`)
    .bind(ownerId, publicationId, range.from, range.to).all<AggregateRow>();
  const totals = emptyTotals();
  for (const row of result.results) totals[eventKey(row.event_type)] = Number(row.event_count);
  const unique = await db.prepare("SELECT COALESCE(SUM(unique_count), 0) AS count FROM analytics_aggregates WHERE owner_id = ? AND publication_id = ? AND granularity = 'day' AND event_type = 'view' AND bucket_start >= ? AND bucket_start < ?")
    .bind(ownerId, publicationId, range.from, range.to).first<{ count: number }>();
  return Response.json({ publicationId, from: range.from, to: range.to, totals, uniqueVisitorsDailySum: Number(unique?.count ?? 0), uniqueVisitorSemantics: "sum_of_daily_unique_viewers" });
}

async function timeSeries(db: D1Database, ownerId: string, publicationId: string, url: URL): Promise<Response> {
  const range = dateRange(url);
  const granularity = url.searchParams.get("granularity") ?? "day";
  if (!range || !["hour", "day"].includes(granularity)) return Response.json({ error: "invalid_analytics_query" }, { status: 400 });
  const result = await db.prepare(`SELECT bucket_start, event_type, event_count, unique_count FROM analytics_aggregates
    WHERE owner_id = ? AND publication_id = ? AND granularity = ? AND bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start, event_type LIMIT ?`)
    .bind(ownerId, publicationId, granularity, range.from, range.to, MAX_TIME_SERIES_POINTS).all<TimeSeriesRow>();
  return Response.json({ publicationId, granularity, from: range.from, to: range.to, points: result.results.map((row) => ({ bucketStart: row.bucket_start, eventType: row.event_type, count: Number(row.event_count), uniqueVisitors: Number(row.unique_count) })) });
}

async function redactedEvents(db: D1Database, ownerId: string, publicationId: string, url: URL): Promise<Response> {
  const range = dateRange(url);
  if (!range) return Response.json({ error: "invalid_date_range" }, { status: 400 });
  const limit = boundedInt(url.searchParams.get("limit"), 50, 1, 100);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (url.searchParams.has("cursor") && !cursor) return Response.json({ error: "invalid_cursor" }, { status: 400 });
  const rows = await db.prepare(`SELECT id, publication_id, version_id, event_type, reaction, country_code, referrer_host, device_class, occurred_at
    FROM analytics_events WHERE owner_id = ? AND publication_id = ? AND occurred_at >= ? AND occurred_at < ? AND (? IS NULL OR occurred_at < ? OR (occurred_at = ? AND id < ?)) ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .bind(ownerId, publicationId, range.from, range.to, cursor?.occurredAt ?? null, cursor?.occurredAt ?? null, cursor?.occurredAt ?? null, cursor?.id ?? null, limit + 1).all<EventRow>();
  const events = rows.results.slice(0, limit).map((row) => ({ id: row.id, publicationId: row.publication_id, versionId: row.version_id, eventType: row.event_type, reaction: row.reaction, countryCode: row.country_code, referrerHost: row.referrer_host, deviceClass: row.device_class, occurredAt: row.occurred_at }));
  const tail = events.at(-1);
  return Response.json({ events, nextCursor: rows.results.length > limit && tail ? encodeCursor({ occurredAt: tail.occurredAt, id: tail.id }) : null });
}

function dateRange(url: URL): { from: string; to: string } | null {
  const now = new Date();
  const from = parseUtc(url.searchParams.get("from"), new Date(now.getTime() - 30 * 86_400_000));
  const to = parseUtc(url.searchParams.get("to"), now);
  return from && to && from.getTime() < to.getTime() && to.getTime() - from.getTime() <= MAX_ANALYTICS_RANGE_MS ? { from: from.toISOString(), to: to.toISOString() } : null;
}

function emptyTotals(): Record<"views" | "downloads" | "shares" | "accessDenied" | "reactions", number> { return { views: 0, downloads: 0, shares: 0, accessDenied: 0, reactions: 0 }; }
function eventKey(type: AnalyticsEventType): "views" | "downloads" | "shares" | "accessDenied" | "reactions" { return ({ view: "views", download: "downloads", share: "shares", access_denied: "accessDenied", reaction: "reactions" } as const)[type]; }
function ownerOwns(actor: AuthActor, ownerId: string): boolean { return isPagecastId(ownerId) && (actor.kind === "bootstrap" || actor.ownerId === ownerId); }
function hasAnalyticsScope(actor: AuthActor): boolean { return actor.kind === "bootstrap" || actor.scopes.includes("*") || actor.scopes.includes("analytics:read"); }
function ownerDailyEventLimit(env: Env): number { return configuredLimit(env.ANALYTICS_DAILY_EVENT_LIMIT, DEFAULT_OWNER_DAILY_EVENT_LIMIT, MAX_OWNER_DAILY_EVENT_LIMIT); }
function globalDailyEventLimit(env: Env): number { return configuredLimit(env.ANALYTICS_GLOBAL_DAILY_EVENT_LIMIT, DEFAULT_GLOBAL_DAILY_EVENT_LIMIT, MAX_GLOBAL_DAILY_EVENT_LIMIT); }
function configuredLimit(value: string | undefined, fallback: number, maximum: number): number { const configured = Number(value); return Number.isInteger(configured) && configured > 0 && configured <= maximum ? configured : fallback; }
function isQuotaExceeded(error: unknown): boolean { return error instanceof Error && /analytics_(?:global|owner)_quota_exceeded/.test(error.message); }
function parseUtc(value: string | null, fallback: Date): Date | null { if (value === null) return fallback; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null; }
function boundedInt(value: string | null, fallback: number, min: number, max: number): number { const result = value === null ? fallback : Number(value); return Number.isInteger(result) && result >= min && result <= max ? result : fallback; }
function encodeCursor(value: { occurredAt: string; id: string }): string { return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decodeCursor(value: string | null): { occurredAt: string; id: string } | null { if (!value || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null; try { const parsed: unknown = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))); return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).occurredAt === "string" && typeof (parsed as Record<string, unknown>).id === "string" ? parsed as { occurredAt: string; id: string } : null; } catch { return null; } }
