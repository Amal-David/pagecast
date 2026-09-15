export type AuthActor =
  | { kind: "bootstrap"; ownerId: null; scopes: ["*"] }
  | { kind: "token"; ownerId: string; tokenId: string; scopes: string[] };

const textEncoder = new TextEncoder();

export function parseBearerAuthorization(header: string | null): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}

export async function digestToken(keyMaterial: string, tokenId: string, tokenSecret: string): Promise<string> {
  return encodeHex(await hmac(keyMaterial, `${tokenId}.${tokenSecret}`));
}

export async function deriveTokenSecret(keyMaterial: string, tokenId: string, idempotencyKey: string): Promise<string> {
  return base64Url(await hmac(keyMaterial, `issued-token:${tokenId}.${idempotencyKey}`));
}

export function parseScopes(value: string): string[] | null {
  try {
    const scopes: unknown = JSON.parse(value);
    return Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string") ? scopes : null;
  } catch {
    return null;
  }
}

export async function hmac(keyMaterial: string, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
}

export function encodeHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64Url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function requestFingerprint(
  method: string,
  pathname: string,
  ownerId: string,
  body: string,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${method}\n${pathname}\n${ownerId}\n${body}`),
  );
  return encodeHex(bytes);
}

export function redactAuditMetadata(value: unknown): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => (isSensitiveKey(key) ? [] : [[key, redactValue(child)]])),
  );
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|cookie|password|secret|token|api[_-]?key|ip|address|path|url|bytes|visitor|capability|share|link)/i.test(key);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}
