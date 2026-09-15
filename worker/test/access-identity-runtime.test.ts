import { describe, expect, it, vi } from "vitest";
import { verifyAccessIdentity } from "../src/access";

function assertion(header: Record<string, unknown>, payload: Record<string, unknown>, signature = "forged") {
  const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode(header)}.${encode(payload)}.${signature}`;
}

const configured = { ACCESS_JWT_ISSUER: "https://team.cloudflareaccess.com", ACCESS_JWT_AUDIENCE: "audience", ACCESS_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs" };

describe("Cloudflare Access identity verification", () => {
  it("rejects bad issuer, audience, and forged signatures instead of trusting request headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ keys: [] })));
    const base = { alg: "RS256", kid: "kid" };
    const validClaims = { iss: configured.ACCESS_JWT_ISSUER, aud: configured.ACCESS_JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60, sub: "access-subject" };
    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": assertion(base, { ...validClaims, iss: "https://attacker.example" }) } }), configured)).resolves.toBeNull();
    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": assertion(base, { ...validClaims, aud: "other" }) } }), configured)).resolves.toBeNull();
    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": assertion(base, validClaims) } }), configured)).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it("does not treat a missing or unconfigured Access header as a verified identity", async () => {
    await expect(verifyAccessIdentity(new Request("https://pagecast.test"), configured)).resolves.toBeNull();
    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }), {})).resolves.toBeNull();
  });

  it("accepts a locally signed RS256 assertion, caches its JWKS, and refreshes on an unknown key id", async () => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = { ...await crypto.subtle.exportKey("jwk", keyPair.publicKey), kid: "rotated-kid", use: "sig", alg: "RS256" };
    const config = { ACCESS_JWT_ISSUER: "https://access.example.test", ACCESS_JWT_AUDIENCE: "audience", ACCESS_JWKS_URL: "https://access.example.test/keys" };
    const claims = encode({ iss: config.ACCESS_JWT_ISSUER, aud: config.ACCESS_JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60, sub: "subject", email: "user@example.test" });
    const header = encode({ alg: "RS256", kid: "rotated-kid" });
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${claims}`));
    const token = `${header}.${claims}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ keys: [publicKey] })));

    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": token } }), config)).resolves.toEqual({ subject: "subject", email: "user@example.test" });
    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": token } }), config)).resolves.toEqual({ subject: "subject", email: "user@example.test" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const unknown = `${encode({ alg: "RS256", kid: "unknown-kid" })}.${claims}.${token.split(".")[2]}`;
    await expect(verifyAccessIdentity(new Request("https://pagecast.test", { headers: { "Cf-Access-Jwt-Assertion": unknown } }), config)).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });
});
