import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const testEnv = {
  ADMIN_TOKEN: "bootstrap-secret-that-must-never-appear-in-a-response",
  ENVIRONMENT: "test",
} as unknown as Env;

const fetch = worker.fetch!;

describe("control-plane boundary", () => {
  it("accepts bootstrap credentials only in a bearer Authorization header", async () => {
    const missing = await fetch(
      new Request("https://pagecast.test/v1/status"),
      testEnv,
      {} as ExecutionContext,
    );
    const query = await fetch(
      new Request("https://pagecast.test/v1/status?token=bootstrap-secret-that-must-never-appear-in-a-response"),
      testEnv,
      {} as ExecutionContext,
    );
    const accepted = await fetch(
      new Request("https://pagecast.test/v1/status", {
        headers: { Authorization: "Bearer bootstrap-secret-that-must-never-appear-in-a-response" },
      }),
      testEnv,
      {} as ExecutionContext,
    );

    expect(missing.status).toBe(401);
    expect(query.status).toBe(401);
    expect(accepted.status).toBe(200);
    const body = await accepted.json() as { apiVersion?: number; capabilities?: string[] };
    expect(body.apiVersion).toBe(2);
    expect(body.capabilities).toEqual(expect.arrayContaining([
      "publications.upload", "publications.access", "publications.versions",
    ]));
    expect(JSON.stringify(body)).not.toContain("bootstrap-secret-that-must-never-appear-in-a-response");
  });

  it("rejects hostile browser control origins without reflecting CORS", async () => {
    const response = await fetch(
      new Request("https://pagecast.test/v1/status", {
        headers: {
          Authorization: "Bearer bootstrap-secret-that-must-never-appear-in-a-response",
          Origin: "https://attacker.example",
        },
      }),
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("projects bounded read-only binding readiness without sending queue messages or reflecting secrets", async () => {
    let queueSends = 0;
    const response = await fetch(new Request("https://custom.pagecast.example/v1/status", {
      headers: { Authorization: "Bearer bootstrap-secret-that-must-never-appear-in-a-response" },
    }), {
      ...testEnv,
      ENVIRONMENT: "staging",
      PUBLIC_ORIGIN: "https://custom.pagecast.example/",
      CF_VERSION_METADATA: { id: "deployment-123" },
      DB: { prepare: () => ({ first: async () => ({ pagecast_status: 1 }) }) },
      PUBLICATIONS: { list: async () => ({ objects: [] }) },
      PUBLICATION_OWNER: { idFromName: () => ({ toString: () => "safe-id" }) },
      JOBS: { send: async () => { queueSends += 1; } },
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    } as unknown as Env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployment: "deployment-123", environment: "staging", hostname: "custom.pagecast.example", customDomain: "custom.pagecast.example",
      bindings: { d1: "ready", r2: "ready", durableObject: "ready", queue: "configured", assets: "ready" },
    });
    expect(queueSends).toBe(0);
  });
});
