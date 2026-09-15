import { describe, expect, it } from "vitest";
import { processQueueBatch } from "../src/index";
import type { JobMessage } from "../src/types";

function message(id: string): JobMessage {
  return { id, ownerId: "queue-owner", kind: "link_check", payload: { jobId: id } };
}

describe("queue batch processing", () => {
  it("caps concurrent message processing at four while retaining each failed message", async () => {
    let active = 0;
    let peak = 0;
    const retries: string[] = [];
    const recovered: string[] = [];
    const failures: string[] = [];
    const messages = Array.from({ length: 9 }, (_, index) => ({ body: message(`queue-${index}`), retry: () => retries.push(`queue-${index}`) }));

    await processQueueBatch(
      messages,
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (item.id === "queue-5") throw new Error("expected failure");
      },
      async (item) => { recovered.push(item.id); },
      (item) => { failures.push(item.id); },
    );

    expect(peak).toBe(4);
    expect(recovered).toEqual(["queue-5"]);
    expect(retries).toEqual(["queue-5"]);
    expect(failures).toEqual(["queue-5"]);
  });

  it("retries a failed message even when durable recovery is temporarily unavailable", async () => {
    let retried = false;
    let reported = false;
    await processQueueBatch(
      [{ body: message("recovery-failure"), retry: () => { retried = true; } }],
      async () => { throw new Error("processing failure"); },
      async () => { throw new Error("recovery failure"); },
      () => { reported = true; },
    );
    expect(retried).toBe(true);
    expect(reported).toBe(true);
  });
});
