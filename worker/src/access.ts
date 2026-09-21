interface AccessEnv {
  ACCESS_JWT_ISSUER?: string;
  ACCESS_JWT_AUDIENCE?: string;
  ACCESS_JWKS_URL?: string;
}

export interface AccessIdentity { subject: string; email: string | null; }
const jwksCache = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();
const MAX_JWKS_CACHE_MS = 5 * 60_000;

/** A supplied Access assertion must verify completely; no Cloudflare request header is an identity. */
export async function verifyAccessIdentity(request: Request, env: AccessEnv): Promise<AccessIdentity | null> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return null;
  if (!env.ACCESS_JWT_ISSUER || !env.ACCESS_JWT_AUDIENCE || !env.ACCESS_JWKS_URL || !validAccessOrigins(env.ACCESS_JWT_ISSUER, env.ACCESS_JWKS_URL)) return null;
  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson(parts[0]) as { alg?: unknown; kid?: unknown };
    const claims = decodeJson(parts[1]) as { iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown; email?: unknown };
    if (header.alg !== "RS256" || typeof header.kid !== "string" || claims.iss !== env.ACCESS_JWT_ISSUER || !audienceMatches(claims.aud, env.ACCESS_JWT_AUDIENCE) || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() || typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    let keys = await cachedKeys(env.ACCESS_JWKS_URL);
    let jwk = keys?.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig");
    if (!jwk) {
      keys = await cachedKeys(env.ACCESS_JWKS_URL, true);
      jwk = keys?.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig");
    }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return verified ? { subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null } : null;
  } catch { return null; }
}

function audienceMatches(audience: unknown, expected: string): boolean { return audience === expected || (Array.isArray(audience) && audience.includes(expected)); }
function decodeJson(value: string): unknown { return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); }
function decodeBase64Url(value: string): Uint8Array { const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }
function validAccessOrigins(issuer: string, jwksUrl: string): boolean { try { const issuerUrl = new URL(issuer); const keysUrl = new URL(jwksUrl); return issuerUrl.protocol === "https:" && keysUrl.protocol === "https:" && issuerUrl.origin === keysUrl.origin; } catch { return false; } }
async function cachedKeys(url: string, refresh = false): Promise<JsonWebKey[] | null> {
  const cached = jwksCache.get(url);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const body = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys)) return null;
  jwksCache.set(url, { keys: body.keys, expiresAt: Date.now() + MAX_JWKS_CACHE_MS });
  return body.keys;
}
