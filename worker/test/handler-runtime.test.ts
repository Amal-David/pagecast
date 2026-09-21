import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env, JobMessage } from "../src/types";

describe("background handlers", () => {
  it("accepts a queue batch", async () => {
    const context = createExecutionContext();
    const batch = createMessageBatch<JobMessage>("pagecast-jobs", [
      {
        id: "job-smoke-test",
        timestamp: Date.now(),
        attempts: 1,
        body: { id: "job-smoke-test", kind: "expire", ownerId: "owner", payload: {} },
      },
    ]);

    await worker.queue!(batch, {} as Env, context);
    await waitOnExecutionContext(context);
  });

  it("cleans transient rows on the scheduled trigger", async () => {
    const statements: string[] = [];
    const db = {
      prepare(query: string) {
        statements.push(query);
        return { run: async () => ({}), all: async () => ({ results: [] }) };
      },
    } as unknown as D1Database;
    const context = createExecutionContext();

    await worker.scheduled!(createScheduledController(), { DB: db, PUBLICATIONS: { delete: async () => undefined } as unknown as R2Bucket } as Env, context);
    await waitOnExecutionContext(context);

    expect(statements.some((statement) => statement.includes("idempotency_keys"))).toBe(true);
    expect(statements.some((statement) => statement.includes("access_grants"))).toBe(true);
    expect(statements.some((statement) => statement.includes("password_attempts"))).toBe(true);
    expect(statements.some((statement) => statement.includes("upload_sessions"))).toBe(true);
    expect(statements.some((statement) => statement.includes("publication_versions"))).toBe(true);
  });
});
