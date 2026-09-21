import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function presence(ownerId: string, publicationId: string, actorId: string) {
  const stub = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerId));
  return stub.fetch("https://pagecast.test/presence", {
    headers: {
      Upgrade: "websocket",
      "X-Pagecast-Owner": ownerId,
      "X-Pagecast-Publication": publicationId,
      "X-Pagecast-Actor": actorId,
    },
  });
}

describe("owner Durable Object presence", () => {
  it("uses separate owner instances and never turns a presence packet into a mutation", async () => {
    const missingUpgrade = await env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName("owner-presence-a")).fetch("https://pagecast.test/presence", {
      headers: { "X-Pagecast-Owner": "owner-presence-a", "X-Pagecast-Publication": "publication-a", "X-Pagecast-Actor": "actor-a" },
    });
    const [left, right] = await Promise.all([
      presence("owner-presence-a", "publication-a", "actor-a"),
      presence("owner-presence-b", "publication-b", "actor-b"),
    ]);

    expect(missingUpgrade.status).toBe(400);
    expect(left.status).toBe(101);
    expect(right.status).toBe(101);
    expect(left.webSocket).not.toBe(right.webSocket);
  });

  it("keeps one connection per actor in a room and enforces the room peer cap", async () => {
    const ownerId = `owner-presence-${crypto.randomUUID()}`;
    const publicationId = `publication-${crypto.randomUUID()}`;
    const sockets: WebSocket[] = [];
    const first = await presence(ownerId, publicationId, "same-actor");
    const replacement = await presence(ownerId, publicationId, "same-actor");
    expect(first.status).toBe(101);
    expect(replacement.status).toBe(101);
    if (replacement.webSocket) sockets.push(replacement.webSocket);

    for (let actor = 0; actor < 31; actor += 1) {
      const response = await presence(ownerId, publicationId, `actor-${actor}`);
      expect(response.status).toBe(101);
      if (response.webSocket) sockets.push(response.webSocket);
    }
    expect((await presence(ownerId, publicationId, "room-overflow")).status).toBe(429);
    for (const socket of sockets) {
      socket.accept();
      socket.close();
    }
  });
});
