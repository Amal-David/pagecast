import { base64Url, digestToken, encodeHex, hmac, parseBearerAuthorization, timingSafeEqual } from "./auth";
import { readBoundedTextBody } from "./body";
import { normalizePath } from "./publications";
import type { Env } from "./types";

const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100_000;
const SESSION_SECONDS = 8 * 60 * 60;

interface PublicationAccessRow {
  publication_id: string;
  title: string;
  slug: string;
  link_kind: "public" | "unlisted";
  active_version_id: string;
  state: string;
  expires_at: string | null;
  mode: "public" | "unlisted" | "password" | "allowlist" | null;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  auth_version: number | null;
  approval_state: "approved" | "pending" | "rejected" | null;
}

interface FileRow {
  normalized_path: string;
  r2_key: string;
  byte_size: number;
  sha256: string;
  content_type: string;
}

interface RedirectRow { destination_path: string; status_code: number; }

export async function handlePublicDelivery(request: Request, env: Env, url: URL): Promise<Response | null> {
  const route = /^\/p\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!route) return null;
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
  let slug: string;
  try { slug = decodeURIComponent(route[1]); } catch { return hidden(); }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return hidden();
  const tail = route[2] ?? '';
  const access = await lookupAccess(env.DB, slug);
  if (!access) return await resolveRedirect(env.DB, slug, tail);

  if (!isLive(access)) return hidden();
  if (tail === '_auth/password' && request.method === 'POST') return passwordLogin(request, env, access);
  if (tail === '_auth/logout' && request.method === 'POST') return logout(slug);
  const allowed = await authorized(request, env, access);
  if (!allowed) return unauthorized(access);

  if (tail === '_social' || tail === '_social/') return socialDocument(access, url);
  if (tail === '_social/card.svg') return socialCard(access);
  if (request.method === 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (tail && forbiddenPublicPath(tail)) return hidden();

  const negotiation = negotiate(request.headers.get('Accept'), tail);
  if (!negotiation) return new Response('Not acceptable', { status: 406, headers: publicHeaders(access) });
  const path = negotiation.path;
  const file = await env.DB.prepare('SELECT normalized_path, r2_key, byte_size, sha256, content_type FROM version_files WHERE version_id = ? AND normalized_path = ?')
    .bind(access.active_version_id, path).first<FileRow>();
  if (!file) return hidden();
  if (negotiation.social && isSocialCrawler(request.headers.get('User-Agent'))) return socialDocument(access, url);
  return deliverFile(request, env, access, file, negotiation.metadata);
}

async function lookupAccess(db: D1Database, slug: string): Promise<PublicationAccessRow | null> {
  return db.prepare(`SELECT p.id AS publication_id, p.title, p.slug, p.link_kind, p.active_version_id, p.state, p.expires_at,
    ap.mode, ap.password_hash, ap.password_salt, ap.password_iterations, ap.auth_version, ap.approval_state
    FROM publications p LEFT JOIN access_policies ap ON ap.publication_id = p.id WHERE p.slug = ? AND p.deleted_at IS NULL`)
    .bind(slug).first<PublicationAccessRow>();
}

function isLive(access: PublicationAccessRow): boolean {
  return access.state === 'published' && !!access.active_version_id && (!access.expires_at || Date.parse(access.expires_at) > Date.now()) && (access.approval_state ?? 'approved') === 'approved';
}

async function resolveRedirect(db: D1Database, source: string, tail: string): Promise<Response> {
  const redirect = await db.prepare('SELECT destination_path, status_code FROM redirects WHERE source_path = ? ORDER BY created_at DESC LIMIT 1').bind(source).first<RedirectRow>();
  if (!redirect || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(redirect.destination_path)) return hidden();
  const destination = await lookupAccess(db, redirect.destination_path);
  if (!destination || !isLive(destination)) return hidden();
  return Response.redirect(`/p/${redirect.destination_path}${tail ? `/${tail}` : ''}`, redirect.status_code as 301 | 302 | 307 | 308);
}

function negotiate(accept: string | null, tail: string): { path: string; metadata: boolean; social: boolean } | null {
  if (tail && !normalizePath(tail)) return null;
  if (tail) return { path: tail, metadata: false, social: false };
  const ranges = parseAccept(accept ?? '*/*');
  const candidates = [
    { type: 'text/html', path: 'index.html', metadata: false, social: true },
    { type: 'text/markdown', path: 'index.md', metadata: false, social: false },
    { type: 'application/json', path: 'index.html', metadata: true, social: false },
  ];
  return candidates
    .map((candidate, order) => ({ ...candidate, order, quality: mediaQuality(candidate.type, ranges) }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.order - right.order)[0] ?? null;
}

interface MediaRange { type: string; quality: number; specificity: number; order: number; }
function parseAccept(value: string): MediaRange[] {
  return value.split(',').flatMap((raw, order) => {
    const [typePart, ...parameters] = raw.trim().toLowerCase().split(';').map((part) => part.trim());
    if (!/^(?:\*|[a-z0-9!#$&^_.+-]+)\/(?:\*|[a-z0-9!#$&^_.+-]+)$/.test(typePart)) return [];
    const qualityParameter = parameters.find((parameter) => parameter.startsWith('q='));
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) return [];
    const specificity = typePart === '*/*' ? 0 : typePart.endsWith('/*') ? 1 : 2;
    return [{ type: typePart, quality, specificity, order }];
  });
}
function mediaQuality(type: string, ranges: MediaRange[]): number {
  const [family] = type.split('/');
  const match = ranges
    .filter((range) => range.type === type || range.type === `${family}/*` || range.type === '*/*')
    .sort((left, right) => right.specificity - left.specificity || left.order - right.order)[0];
  return match?.quality ?? 0;
}
function forbiddenPublicPath(path: string): boolean { return path.toLowerCase().endsWith('.map'); }

async function authorized(request: Request, env: Env, access: PublicationAccessRow): Promise<boolean> {
  const mode = access.mode ?? access.link_kind;
  if (mode === 'public' || mode === 'unlisted') return true;
  if (mode === 'password' && await validSession(request, env, access)) return true;
  return mode === 'allowlist' && await validGrant(request, env, access);
}

async function validGrant(request: Request, env: Env, access: PublicationAccessRow): Promise<boolean> {
  const credential = parseBearerAuthorization(request.headers.get('Authorization'));
  const match = /^pcg_([A-Za-z0-9_-]{32,64})\.([A-Za-z0-9_-]{32,})$/.exec(credential ?? '');
  if (!match) return false;
  const [, id, secret] = match;
  const grant = await env.DB.prepare("SELECT principal_value FROM access_grants WHERE id = ? AND publication_id = ? AND principal_type = 'token' AND permission IN ('view', 'comment', 'edit') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
    .bind(id, access.publication_id).first<{ principal_value: string }>();
  return !!grant && timingSafeEqual(grant.principal_value, await digestToken(env.TOKEN_HASH_KEY, id, secret));
}

async function validSession(request: Request, env: Env, access: PublicationAccessRow): Promise<boolean> {
  const cookie = cookieValue(request.headers.get('Cookie'), sessionCookieName());
  if (!cookie || !access.auth_version) return false;
  const [version, expires, signature] = cookie.split('.');
  if (!/^[0-9]+$/.test(version) || !/^[0-9]+$/.test(expires) || !/^[A-Za-z0-9_-]{43}$/.test(signature) || Number(version) !== access.auth_version || Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(env.COOKIE_SIGNING_KEY, `${access.publication_id}.${version}.${expires}`);
  return timingSafeEqual(signature, expected);
}

async function passwordLogin(request: Request, env: Env, access: PublicationAccessRow): Promise<Response> {
  if ((access.mode ?? access.link_kind) !== 'password' || !access.password_hash || !access.password_salt || !access.auth_version) return hidden();
  const fingerprint = await requestFingerprint(env, request);
  const attempt = await env.DB.prepare('SELECT failed_count, window_started_at, blocked_until FROM password_attempts WHERE publication_id = ? AND fingerprint = ?').bind(access.publication_id, fingerprint).first<{ failed_count: number; window_started_at: string; blocked_until: string | null }>();
  if (attempt?.blocked_until && Date.parse(attempt.blocked_until) > Date.now()) return new Response('Too many attempts', { status: 429, headers: { 'Retry-After': String(Math.ceil((Date.parse(attempt.blocked_until) - Date.now()) / 1000)), ...publicHeaders(access) } });
  const password = await formPassword(request);
  const actual = password === null ? '' : await passwordHash(password, access.password_salt, access.password_iterations ?? PASSWORD_ITERATIONS);
  if (!timingSafeEqual(actual, access.password_hash)) {
    await recordFailure(env.DB, access.publication_id, fingerprint);
    return new Response('Unauthorized', { status: 401, headers: { ...publicHeaders(access), 'WWW-Authenticate': 'Pagecast-Password' } });
  }
  await env.DB.prepare('DELETE FROM password_attempts WHERE publication_id = ? AND fingerprint = ?').bind(access.publication_id, fingerprint).run();
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const signature = await sign(env.COOKIE_SIGNING_KEY, `${access.publication_id}.${access.auth_version}.${expires}`);
  return new Response(null, { status: 204, headers: { 'Set-Cookie': `${sessionCookieName()}=${access.auth_version}.${expires}.${signature}; Path=/p/${access.slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`, ...publicHeaders(access) } });
}

async function formPassword(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type')?.split(';')[0];
  if (type !== 'application/x-www-form-urlencoded') return null;
  const body = await readBoundedTextBody(request, 4096);
  return 'tooLarge' in body ? null : new URLSearchParams(body.body).get('password');
}

async function recordFailure(db: D1Database, publicationId: string, fingerprint: string): Promise<void> {
  await db.prepare(`INSERT INTO password_attempts (publication_id, fingerprint, failed_count, window_started_at, blocked_until)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(publication_id, fingerprint) DO UPDATE SET
      failed_count = CASE WHEN password_attempts.window_started_at > datetime('now', '-15 minutes') THEN password_attempts.failed_count + 1 ELSE 1 END,
      window_started_at = CASE WHEN password_attempts.window_started_at > datetime('now', '-15 minutes') THEN password_attempts.window_started_at ELSE CURRENT_TIMESTAMP END,
      blocked_until = CASE WHEN password_attempts.window_started_at > datetime('now', '-15 minutes') AND password_attempts.failed_count + 1 >= 5 THEN datetime('now', '+15 minutes') ELSE NULL END`)
    .bind(publicationId, fingerprint).run();
}

function logout(slug: string): Response { return new Response(null, { status: 204, headers: { 'Set-Cookie': `${sessionCookieName()}=; Path=/p/${slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } }); }
function sessionCookieName(): string { return 'pc_session'; }

async function deliverFile(request: Request, env: Env, access: PublicationAccessRow, file: FileRow, metadata: boolean): Promise<Response> {
  const headers = new Headers(publicHeaders(access));
  if (metadata) return Response.json({ title: access.title, contentType: safeContentType(file.content_type), updated: null }, { headers });
  const range = parseRange(request.headers.get('Range'), file.byte_size);
  headers.set('ETag', `"${file.sha256}"`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', safeContentType(file.content_type));
  headers.set('Content-Disposition', inlineContent(file.content_type) ? 'inline' : `attachment; filename="${safeFilename(file.normalized_path)}"`);
  if (request.headers.get('If-None-Match') === `"${file.sha256}"`) return new Response(null, { status: 304, headers });
  if (range === 'invalid') { headers.set('Content-Range', `bytes */${file.byte_size}`); return new Response(null, { status: 416, headers }); }
  if (range) { headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.byte_size}`); headers.set('Content-Length', String(range.end - range.start + 1)); }
  else headers.set('Content-Length', String(file.byte_size));
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const object = await env.PUBLICATIONS.get(file.r2_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return hidden();
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function parseRange(value: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size < 1) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';
  let start: number; let end: number;
  if (!rawStart) { const length = Number(rawEnd); if (!Number.isSafeInteger(length) || length < 1) return 'invalid'; start = Math.max(0, size - length); end = size - 1; }
  else { start = Number(rawStart); end = rawEnd ? Number(rawEnd) : size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid'; end = Math.min(end, size - 1); }
  return { start, end };
}

function safeContentType(value: string): string {
  const type = value.toLowerCase().split(';')[0];
  return /^(?:text\/(?:html|plain|css|markdown)|application\/(?:javascript|json|wasm|pdf)|image\/(?:avif|gif|jpeg|png|svg\+xml|webp)|font\/(?:woff2?|ttf)|audio\/(?:mpeg|ogg|wav)|video\/(?:mp4|webm))$/.test(type) ? type : 'application/octet-stream';
}
function inlineContent(value: string): boolean { return !['application/octet-stream', 'application/pdf'].includes(safeContentType(value)); }
function safeFilename(path: string): string { return path.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]+/g, '-') || 'download'; }
function publicHeaders(access: PublicationAccessRow): Record<string, string> {
  const privateResource = (access.mode ?? access.link_kind) !== 'public';
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Content-Security-Policy': "default-src 'self' https: data: blob:; script-src 'self' https: blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https: wss:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    'X-Robots-Tag': privateResource ? 'noindex, nofollow, noarchive' : 'index, follow',
    'Cache-Control': privateResource ? 'private, no-store' : 'public, max-age=0, must-revalidate',
  };
}
function unauthorized(access: PublicationAccessRow): Response { return new Response('Unauthorized', { status: 401, headers: { ...publicHeaders(access), 'WWW-Authenticate': (access.mode ?? access.link_kind) === 'password' ? 'Pagecast-Password' : 'Bearer' } }); }
function hidden(): Response { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
function socialDocument(access: PublicationAccessRow, url: URL): Response { const title = escapeHtml(access.title); const image = socialCardUrl(url, access); return new Response(`<!doctype html><meta property="og:title" content="${title}"><meta property="og:image" content="${image}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${image}">`, { headers: { ...publicHeaders(access), 'Content-Type': 'text/html; charset=utf-8' } }); }
function socialCard(access: PublicationAccessRow): Response { const title = escapeHtml(access.title).slice(0, 180); return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" role="img"><rect width="100%" height="100%" fill="#111827"/><text x="72" y="315" fill="#fff" font-size="48" font-family="system-ui">${title}</text></svg>`, { headers: { ...publicHeaders(access), 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'inline' } }); }
function socialCardUrl(url: URL, access: PublicationAccessRow): string { return new URL(`/p/${encodeURIComponent(access.slug)}/_social/card.svg`, url).toString(); }
function isSocialCrawler(value: string | null): boolean { return /(?:Twitterbot|facebookexternalhit|Slackbot|Discordbot|LinkedInBot|WhatsApp)/i.test(value ?? ''); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function cookieValue(header: string | null, name: string): string | null { return header?.split(/;\s*/).find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? null; }
async function passwordHash(password: string, salt: string, iterations: number): Promise<string> { const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations }, key, 256); return encodeHex(bits); }
export async function hashPassword(password: string, salt: string, iterations = PASSWORD_ITERATIONS): Promise<string> { return passwordHash(password, salt, iterations); }
async function sign(key: string, value: string): Promise<string> { return base64Url(await hmac(key, value)); }
async function requestFingerprint(env: Env, request: Request): Promise<string> { return sign(env.COOKIE_SIGNING_KEY, request.headers.get('CF-Connecting-IP') ?? 'unknown'); }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)); }
