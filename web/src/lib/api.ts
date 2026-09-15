import type {
  CloudflareSyncResponse,
  CloudflareConnectionJob,
  AccessEventsResponse,
  AnalyticsSummaryResponse,
  CloudflareProjectsResponse,
  ConfigResponse,
  ContentResponse,
  DeleteDeploymentResponse,
  DeploymentsResponse,
  FeedbackSetupResponse,
  FeedbackStatsResponse,
  OperationRetryResponse,
  OperationsResponse,
  PruneDeploymentsResponse,
  PublishResponse,
  Report,
  ReportResponse,
  ReportsResponse,
  StatusResponse
} from "@/lib/types";
import type {
  AppConfig,
  WorkerAccessInput,
  WorkerAuditPage,
  WorkerGrantInput,
  WorkerJobInput,
  WorkerMutationResult,
  WorkerOverview,
  WorkerOverviewSection,
  WorkerWebhookInput
} from "@/lib/types";
import { createCsrfRecovery } from "@/lib/csrf-recovery.js";

// Mirrors the server error envelope: { error: { message, statusCode } }.
export class ApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

const csrfRecovery = createCsrfRecovery({
  fetchImpl: (input, init) => fetch(input, init),
  createSessionError: (message, statusCode) => new ApiError(message, statusCode)
});

async function request<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const { json, headers, ...rest } = options;
  const requestHeaders = new Headers(headers);
  const init: RequestInit = {
    ...rest,
    credentials: rest.credentials ?? "same-origin",
    headers: requestHeaders
  };

  if (json !== undefined) {
    init.method = init.method ?? "POST";
    requestHeaders.set("Content-Type", "application/json");
    init.body = JSON.stringify(json);
  }

  const response = await csrfRecovery.fetch(path, init);

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

  getOperations: () => request<OperationsResponse>("/api/operations"),

  retryOperation: (id: string) =>
    request<OperationRetryResponse>(
      `/api/operations/${encodeURIComponent(id)}/retry`,
      { json: {} }
    ),

  addPath: (path: string) =>
    request<ReportResponse>("/api/reports/path", { json: { path } }),

  addFolder: (payload: {
    path: string;
    entryFile?: string;
    buildCommand?: string;
    buildOutputDir?: string;
    name?: string;
  }) => request<ReportResponse>("/api/reports/folder", { json: payload }),

  uploadFile: (file: File) => {
    const formData = new FormData();
    formData.append("report", file, file.name);
    return request<ReportResponse>("/api/reports/upload", {
      method: "POST",
      body: formData
    });
  },

  uploadFolder: (files: File[]) => {
    const formData = new FormData();
    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      formData.append("files", file, relativePath);
    }
    return request<ReportResponse>("/api/reports/folder-upload", {
      method: "POST",
      body: formData
    });
  },

  buildReport: (id: string) =>
    request<ReportResponse>(`/api/reports/${encodeURIComponent(id)}/build`, {
      json: {}
    }),

  reorder: (ids: string[]) =>
    request<ReportsResponse>("/api/reports/reorder", { json: { ids } }),

  deleteReport: (id: string) =>
    request<{ removed: boolean; cleanupPending: boolean; cleanupError: string | null }>(
      `/api/reports/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),

  publishSnapshot: (id: string, options?: { label?: string; drop?: boolean }) =>
    request<PublishResponse>(
      `/api/reports/${encodeURIComponent(id)}/publish-snapshot`,
      { json: { label: options?.label, drop: options?.drop } }
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

  setPasswordProtection: (id: string, enabled: boolean, password?: string) =>
    request<ReportResponse>(
      `/api/reports/${encodeURIComponent(id)}/password-protection`,
      { json: { enabled, password } }
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

  setExpiry: (token: string, expires: string) =>
    request<PublishResponse>(
      `/api/publications/${encodeURIComponent(token)}/expiry`,
      { json: { expires } }
    ),

  setDefaultExpiry: (value: string) =>
    request<ConfigResponse>("/api/config/expiry", {
      json: { default: value }
    }),

  setCloudflareSyncEnabled: (enabled: boolean) =>
    request<ConfigResponse>("/api/config/cloudflare-sync", {
      json: { enabled }
    }),

  configurePages: (payload: {
    projectName: string;
    accountId?: string;
    accountName?: string;
    baseUrl?: string;
    adoptExisting?: boolean;
  }) => request<ConfigResponse>("/api/config/pages", { json: payload }),

  adoptPublicationTarget: (token: string) =>
    request<PublishResponse>(`/api/publications/${encodeURIComponent(token)}/target`, {
      json: { confirm: true }
    }),

  cloudflareConnect: () =>
    request<unknown>("/api/cloudflare/connect", { json: {} }),

  startCloudflareConnectionJob: (payload: { projectName: string; accountId?: string }) =>
    request<CloudflareConnectionJob>("/api/cloudflare/connect-jobs", { json: payload }),

  getCloudflareConnectionJob: (jobId: string) =>
    request<CloudflareConnectionJob>(
      `/api/cloudflare/connect-jobs/${encodeURIComponent(jobId)}`
    ),

  cloudflareProjects: () =>
    request<CloudflareProjectsResponse>("/api/cloudflare/projects", { json: {} }),

  cloudflareAccount: (accountId: string) =>
    request<unknown>("/api/cloudflare/account", { json: { accountId } }),

  cloudflareLogout: () =>
    request<unknown>("/api/cloudflare/logout", { json: {} }),

  syncCloudflarePages: () =>
    request<CloudflareSyncResponse>("/api/cloudflare/sync", { json: {} }),

  feedbackSetup: (options: { accountId?: string; reactions?: boolean } = {}) =>
    request<FeedbackSetupResponse>("/api/feedback/setup", {
      json: options
    }),

  feedbackStats: (slug: string) =>
    request<FeedbackStatsResponse>(
      `/api/feedback/stats?slug=${encodeURIComponent(slug)}`
    ),

  analyticsSummary: (publicationId?: string) =>
    request<AnalyticsSummaryResponse>(
      `/api/analytics/summary${publicationId ? `?publicationId=${encodeURIComponent(publicationId)}` : ""}`
    ),

  analyticsEvents: (options: { publicationId?: string; cursor?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.publicationId) params.set("publicationId", options.publicationId);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return request<AccessEventsResponse>(`/api/analytics/events${query ? `?${query}` : ""}`);
  },

  getDeployments: () => request<DeploymentsResponse>("/api/deployments"),

  deleteDeployment: (id: string, force = false) =>
    request<DeleteDeploymentResponse>(
      `/api/deployments/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
      { method: "DELETE" }
    ),

  pruneDeployments: (keep: number) =>
    request<PruneDeploymentsResponse>("/api/deployments/prune", {
      json: { keep }
    }),

  workerStatus: () => request<{ workers: NonNullable<AppConfig["workers"]> }>("/api/workers/status"),
  connectWorker: (payload: { origin: string; ownerId: string; token: string; allowLoopbackHttp?: boolean }) => request<ConfigResponse>("/api/workers/connect", { json: payload }),
  disconnectWorker: (profileId: string) => request<ConfigResponse>(`/api/workers/${encodeURIComponent(profileId)}`, { method: "DELETE" }),
  checkWorkerHealth: (profileId: string) => request<{ workers: NonNullable<AppConfig["workers"]> }>(`/api/workers/${encodeURIComponent(profileId)}/health`, { json: {} }),
  workerOverview: (token: string, section: WorkerOverviewSection) => request<WorkerOverview>(`/api/worker-publications/${encodeURIComponent(token)}/overview?section=${encodeURIComponent(section)}`),
  workerAudit: (token: string, cursor?: string) => request<WorkerAuditPage>(`/api/worker-publications/${encodeURIComponent(token)}/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  workerVersion: (token: string, versionId: string, action: "activate" | "rollback") => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/versions/${encodeURIComponent(versionId)}/${action}`, { json: { confirm: true } }),
  workerAvailability: (token: string, action: "revoke" | "restore") => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/${action}`, { json: { confirm: true } }),
  workerAccess: (token: string, payload: WorkerAccessInput) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/access`, { method: "PUT", json: { ...payload, confirm: true } }),
  workerAccessExpiry: (token: string, expiresAt: string | null) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/access/expiry`, { method: "PATCH", json: { expiresAt, confirm: true } }),
  createWorkerGrant: (token: string, payload: WorkerGrantInput) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/grants`, { json: { ...payload, confirm: true } }),
  revokeWorkerGrant: (token: string, grantId: string) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" }),
  setWorkerOrganization: (token: string, payload: { namespace: string; displayName: string }) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/organization`, { method: "PUT", json: payload }),
  inviteWorkerMember: (token: string, payload: { actorId: string; role: string }) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/members`, { json: payload }),
  removeWorkerMember: (token: string, membershipId: string) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/members/${encodeURIComponent(membershipId)}`, { method: "DELETE" }),
  createWorkerComment: (token: string, payload: { body: string; versionId?: string }) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/comments`, { json: payload }),
  resolveWorkerComment: (token: string, commentId: string, resolved: boolean) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/comments/${encodeURIComponent(commentId)}/resolve`, { json: { resolved } }),
  deleteWorkerComment: (token: string, commentId: string) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }),
  createWorkerReview: (token: string, payload: { versionId: string; decision: string }) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/collaboration/reviews`, { json: payload }),
  createWorkerWebhook: (token: string, payload: WorkerWebhookInput) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/webhooks`, { json: { ...payload, confirm: true } }),
  updateWorkerWebhook: (token: string, webhookId: string, payload: WorkerWebhookInput) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/webhooks/${encodeURIComponent(webhookId)}`, { method: "PATCH", json: payload }),
  deleteWorkerWebhook: (token: string, webhookId: string) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" }),
  rotateWorkerWebhook: (token: string, webhookId: string) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/webhooks/${encodeURIComponent(webhookId)}/rotate`, { json: { confirm: true } }),
  workerWebhookDeliveries: (token: string, webhookId: string) => request<{ deliveries: Record<string, unknown>[] }>(`/api/worker-publications/${encodeURIComponent(token)}/webhooks/${encodeURIComponent(webhookId)}/deliveries`),
  retryWorkerDelivery: (token: string, webhookId: string, deliveryId: string) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`, { json: { confirm: true } }),
  createWorkerJob: (token: string, payload: WorkerJobInput) => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/jobs`, { json: { ...payload, confirm: true } }),
  workerJobAction: (token: string, jobId: string, action: "cancel" | "retry") => request<WorkerMutationResult>(`/api/worker-publications/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}/${action}`, { json: { confirm: true } }),
  migrateToWorker: (token: string, password?: string) => request<WorkerMutationResult>(`/api/publications/${encodeURIComponent(token)}/migrate-to-worker`, { json: { confirm: true, ...(password ? { password } : {}) } })
};
