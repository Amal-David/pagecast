import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Pagecast Worker", () => {
  it("serves a health response from the deployed handler", async () => {
    const response = await exports.default.fetch("https://pagecast.test/health");

    await expect(response.json()).resolves.toEqual({ service: "pagecast", status: "ok" });
  });

  it("binds a per-owner Durable Object", async () => {
    const id = env.PUBLICATION_OWNER.idFromName("owner-smoke-test");
    const response = await env.PUBLICATION_OWNER.get(id).fetch("https://pagecast.test/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ durableObject: "publication-owner" });
  });

  it("serializes mutations per owner without sharing sequences across owners", async () => {
    const ownerAId = `owner-serial-a-${crypto.randomUUID()}`;
    const ownerBId = `owner-serial-b-${crypto.randomUUID()}`;
    const ownerA = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerAId));
    const ownerB = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerBId));
    const mutation = (owner: DurableObjectStub) => owner.fetch("https://pagecast.test/mutate", {
      method: "POST",
      headers: { "X-Pagecast-Owner": owner === ownerA ? ownerAId : ownerBId },
    });

    const [firstA, secondA, firstB] = await Promise.all([mutation(ownerA), mutation(ownerA), mutation(ownerB)]);

    const ownerAResults = await Promise.all([
      firstA.json<{ ownerId: string; sequence: number }>(),
      secondA.json<{ ownerId: string; sequence: number }>(),
    ]);
    expect(ownerAResults.map((result) => result.ownerId)).toEqual([ownerAId, ownerAId]);
    expect(ownerAResults.map((result) => result.sequence).sort()).toEqual([1, 2]);
    await expect(firstB.json()).resolves.toEqual({ ownerId: ownerBId, sequence: 1 });
  });
});
