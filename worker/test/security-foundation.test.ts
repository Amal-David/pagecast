import { describe, expect, it } from "vitest";
import {
  digestToken,
  parseBearerAuthorization,
  redactAuditMetadata,
  requestFingerprint,
} from "../src/auth";

describe("security primitives", () => {
  it("parses only a single bearer credential", () => {
    expect(parseBearerAuthorization("Bearer token")).toBe("token");
    expect(parseBearerAuthorization("bearer token")).toBeNull();
    expect(parseBearerAuthorization("Basic token")).toBeNull();
    expect(parseBearerAuthorization("Bearer token extra")).toBeNull();
  });

  it("derives a keyed token digest without retaining the raw secret", async () => {
    const digest = await digestToken("key", "token-id", "raw-token-secret");

    expect(digest).not.toContain("raw-token-secret");
    expect(await digestToken("key", "token-id", "raw-token-secret")).toBe(digest);
    expect(await digestToken("other-key", "token-id", "raw-token-secret")).not.toBe(digest);
  });

  it("binds idempotency receipts to method, path, owner, and body", async () => {
    const original = await requestFingerprint("POST", "/v1/owners/a/coordinator", "a", '{"value":1}');

    expect(await requestFingerprint("POST", "/v1/owners/a/coordinator", "a", '{"value":1}')).toBe(original);
    expect(await requestFingerprint("POST", "/v1/owners/a/coordinator", "a", '{"value":2}')).not.toBe(original);
    expect(await requestFingerprint("POST", "/v1/owners/b/coordinator", "b", '{"value":1}')).not.toBe(original);
  });

  it("redacts credentials and local paths before audit persistence", () => {
    expect(
      redactAuditMetadata({
        authorization: "Bearer raw-secret",
        password: "open-sesame",
        path: "/Users/amal/private/report.html",
        visitorHmac: "derived-visitor-identity",
        shareLink: "https://pagecast.test/p/capability-secret",
        safe: "kept",
        nested: { token: "raw-token" },
      }),
    ).toEqual({ safe: "kept", nested: {} });
  });
});
