import type {
  ContentResponse,
  PublishResponse,
  Report,
  ReportResponse,
  ReportsResponse,
  StatusResponse
} from "@/lib/types";

// Mirrors the server error envelope: { error: { message, statusCode } }.
export class ApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const { json, headers, ...rest } = options;
  const init: RequestInit = { ...rest, headers: { ...headers } };

  if (json !== undefined) {
    init.method = init.method ?? "POST";
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(json);
  }

  const response = await fetch(path, init);

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let statusCode = response.status;
    try {
      const body = await response.json();
      if (body?.error?.message) {
        message = body.error.message;
      }
      if (typeof body?.error?.statusCode === "number") {
        statusCode = body.error.statusCode;
      }
    } catch {
      // Non-JSON error body (e.g. plain-text 404 from non-API routes).
    }
    throw new ApiError(message, statusCode);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  getStatus: () => request<StatusResponse>("/api/status"),

  getReports: () => request<ReportsResponse>("/api/reports"),

  addPath: (path: string) =>
    request<ReportResponse>("/api/reports/path", { json: { path } }),

  reorder: (ids: string[]) =>
    request<ReportsResponse>("/api/reports/reorder", { json: { ids } }),

  deleteReport: (id: string) =>
    request<{ removed: boolean }>(`/api/reports/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  publishSnapshot: (id: string, label?: string) =>
    request<PublishResponse>(
      `/api/reports/${encodeURIComponent(id)}/publish-snapshot`,
      { json: { label } }
    ),

  revokeAll: (id: string) =>
    request<{ revokedCount: number; report: Report }>(
      `/api/reports/${encodeURIComponent(id)}/revoke-all`,
      { json: {} }
    ),

  setAutoSync: (id: string, enabled: boolean) =>
    request<ReportResponse>(
      `/api/reports/${encodeURIComponent(id)}/auto-sync`,
      { json: { enabled } }
    ),

  getContent: (id: string) =>
    request<ContentResponse>(`/api/reports/${encodeURIComponent(id)}/content`),

  saveContent: (id: string, html: string) =>
    request<ReportResponse>(`/api/reports/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      json: { html }
    }),

  syncPublication: (token: string) =>
    request<PublishResponse>(
      `/api/publications/${encodeURIComponent(token)}/sync`,
      { json: {} }
    ),

  revokePublication: (token: string) =>
    request<PublishResponse>(
      `/api/publications/${encodeURIComponent(token)}/revoke`,
      { json: {} }
    ),

  renameSlug: (token: string, slug: string) =>
    request<PublishResponse>(
      `/api/publications/${encodeURIComponent(token)}/slug`,
      { method: "PUT", json: { slug } }
    ),

  cloudflareConnect: () =>
    request<unknown>("/api/cloudflare/connect", { json: {} }),

  cloudflareAccount: (accountId: string) =>
    request<unknown>("/api/cloudflare/account", { json: { accountId } })
};
