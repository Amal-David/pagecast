import { describe, expect, it } from "vitest";
import { handleMcpRequest, MCP_CAPABILITY_MAP, MCP_REGISTERED_TOOL_NAMES } from "../src/mcp";
import type { AuthActor } from "../src/auth";
import type { Env } from "../src/types";

const ownerId = "mcp-owner";
const fullActor: AuthActor = {
  kind: "token",
  ownerId,
  tokenId: "11111111-1111-4111-8111-111111111111",
  actorId: "mcp-owner-actor",
  scopes: ["status:read", "publications:read", "publications:write", "collaboration:read", "collaboration:write", "collaboration:admin", "reviews:write", "analytics:read", "audit:read", "webhooks:read", "webhooks:write", "jobs:read", "jobs:write"],
};

function env(expiresAt = "2099-01-01T00:00:00.000Z") {
  return {
    DB: {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("SELECT expires_at") ? { expires_at: expiresAt } : query.includes("FROM collaboration_memberships") ? { role: "owner" } : null,
          all: async () => ({ results: [] }),
        }),
      }),
    },
    MCP_ALLOWED_HOSTNAMES: "pagecast.test",
    MCP_ALLOWED_ORIGIN_HOSTNAMES: "pagecast.test",
  } as unknown as Env;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://pagecast.test/mcp", {
    method: "POST",
    headers: { Host: "pagecast.test", Accept: "application/json, text/event-stream", Authorization: "Bearer pcv2_example", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

type MappedCapability = {
  action: string;
  tool: string;
  scope: string;
  roles?: readonly ("owner" | "commenter" | "editor" | "approver")[];
  requirement?: string;
  destructive?: true;
};

function isMappedCapability(entry: (typeof MCP_CAPABILITY_MAP)[number]): entry is MappedCapability {
  return typeof entry.tool === "string";
}

async function call(body: unknown, actor = fullActor, expiresAt?: string) {
  const seen: Request[] = [];
  const response = await handleMcpRequest(request(body), env(expiresAt), {} as ExecutionContext, {
    authenticate: async () => actor,
    dispatchControl: async (input) => {
      seen.push(input);
      return Response.json({ id: "safe-id", status: "ok", publicUrl: "https://pagecast.test/p/example" });
    },
  });
  return { response, seen };
}

async function jsonRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text) as Record<string, unknown>;
}

describe("remote Pagecast MCP", () => {
  it("initializes through the stateless Streamable HTTP handler", async () => {
    const { response } = await call(initialize);
    expect(response.status).toBe(200);
    await expect(jsonRpc(response)).resolves.toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "pagecast" } } });
  });

  it("keeps an exact capability map and filters discovery by token scope", async () => {
    const limited = { ...fullActor, scopes: ["status:read"] } as AuthActor;
    const { response } = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, limited);
    const body = await jsonRpc(response) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["pagecast_status"]);
    expect(MCP_CAPABILITY_MAP.every((entry) => Boolean(entry.tool) !== Boolean(entry.exception))).toBe(true);
    expect(MCP_CAPABILITY_MAP.filter(isMappedCapability).every((entry) => MCP_REGISTERED_TOOL_NAMES.has(entry.tool))).toBe(true);
    expect([...MCP_REGISTERED_TOOL_NAMES].every((tool) => MCP_CAPABILITY_MAP.some((entry) => entry.tool === tool))).toBe(true);
    const mapped = MCP_CAPABILITY_MAP.filter(isMappedCapability);
    expect(mapped).toHaveLength(55);
    expect(new Set(mapped.map((entry) => entry.action)).size).toBe(55);
    expect(new Set(mapped.map((entry) => entry.tool))).toEqual(MCP_REGISTERED_TOOL_NAMES);
    expect(mapped.every((entry) => entry.scope.length > 0)).toBe(true);
    expect(MCP_CAPABILITY_MAP.filter((entry) => entry.exception)).toHaveLength(3);
    expect(mapped.find((entry) => entry.tool === "membership_accept")).toMatchObject({
      scope: "collaboration:write",
      requirement: "Token-bound invited actor with a pending membership and its invitation credential.",
    });
    expect(mapped.find((entry) => entry.tool === "comment_create")?.roles).toEqual(["commenter", "editor", "approver", "owner"]);
    expect(mapped.find((entry) => entry.tool === "review_decide")?.roles).toEqual(["approver", "owner"]);
    expect(mapped.find((entry) => entry.tool === "organization_set")?.roles).toEqual(["owner"]);
    expect(mapped.filter((entry) => entry.destructive).map((entry) => entry.tool).sort()).toEqual([
      "access_revoke_grant", "actor_remove", "collaboration_grant_revoke", "comment_delete", "job_cancel", "job_retry", "membership_remove", "publication_delete_version", "publication_revoke", "webhook_delete", "webhook_delivery_retry",
    ].sort());
  });

  it("exposes every mapped tool to a full-scope owner token", async () => {
    const { response } = await call({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    const body = await jsonRpc(response) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([...MCP_REGISTERED_TOOL_NAMES].sort());
  });

  it("rejects hostile origins, hosts, batches, bootstrap, expired tokens, and missing authorization", async () => {
    const dependencies = { authenticate: async () => fullActor, dispatchControl: async () => Response.json({}) };
    const hostileOrigin = new Request("https://pagecast.test/mcp", { method: "POST", headers: { Origin: "https://evil.test", Authorization: "Bearer pcv2_example" }, body: JSON.stringify(initialize) });
    expect((await handleMcpRequest(hostileOrigin, env(), {} as ExecutionContext, dependencies)).status).toBe(403);
    const hostileHost = new Request("https://pagecast.test/mcp", { method: "POST", headers: { Host: "evil.test", Authorization: "Bearer pcv2_example" }, body: JSON.stringify(initialize) });
    expect((await handleMcpRequest(hostileHost, env(), {} as ExecutionContext, dependencies)).status).toBe(403);
    expect((await call([initialize])).response.status).toBe(400);
    expect((await call(initialize, { kind: "bootstrap", ownerId: null, scopes: ["*"] } as AuthActor)).response.status).toBe(401);
    expect((await call(initialize, fullActor, "2000-01-01T00:00:00.000Z")).response.status).toBe(401);
    const missing = new Request("https://pagecast.test/mcp", { method: "POST", body: JSON.stringify(initialize) });
    expect((await handleMcpRequest(missing, env(), {} as ExecutionContext, { authenticate: async () => null, dispatchControl: async () => Response.json({}) })).status).toBe(401);
  });

  it("requires confirmation and idempotency keys for protected write tools", async () => {
    const noConfirmation = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "publication_delete_version", arguments: { publicationId: "publication", versionId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "delete-once" } } });
    const noConfirmationBody = await jsonRpc(noConfirmation.response) as { result: { isError: boolean } };
    expect(noConfirmationBody.result.isError).toBe(true);
    expect(noConfirmation.seen).toHaveLength(0);
    const noKey = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "publication_revoke", arguments: { publicationId: "publication", confirm: true } } });
    expect(await jsonRpc(noKey.response)).toMatchObject({ result: { isError: true } });
    const retry = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "job_retry", arguments: { jobId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "retry-once" } } });
    expect((await jsonRpc(retry.response) as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(retry.seen).toHaveLength(0);
  });

  it("reuses the in-process control path and redacts credentials from outcomes", async () => {
    const { response, seen } = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "publication_revoke", arguments: { publicationId: "publication", confirm: true, idempotencyKey: "revoke-once" } } });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe(`/v1/owners/${ownerId}/publications/publication/revoke`);
    expect(seen[0].headers.get("Idempotency-Key")).toBe("revoke-once");
    const body = await response.text();
    expect(body).not.toContain("pcv2_example");
  });

  it("rejects an inline base64 upload over 1 MiB before it reaches the HTTP upload route", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "publication_upload_file",
        arguments: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          path: "report.html",
          contentType: "text/html",
          sha256: "a".repeat(64),
          // This is schema-valid base64, but decodes to 1,048,578 bytes.
          contentBase64: "A".repeat(1_398_104),
          idempotencyKey: "upload-once",
        },
      },
    });
    expect(await jsonRpc(response.response)).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("mcp_inline_upload_too_large_use_streaming_http") }] } });
    expect(response.seen).toHaveLength(0);
  });
});
