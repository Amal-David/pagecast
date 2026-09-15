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
    expect(await accepted.text()).not.toContain("bootstrap-secret-that-must-never-appear-in-a-response");
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
});
