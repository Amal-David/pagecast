// Types mirror the exact JSON shapes emitted by src/server.js. Do not invent
// fields: formatReport / formatPublication / /api/status are the source of truth.

export type PublicationKind = "snapshot";

export interface Publication {
  token: string;
  slug: string;
  label: string;
  kind: PublicationKind;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  localUrl: string | null;
  publicUrl: string | null;
}

export type ReportKind = "path" | "upload" | "folder";
export type SourceMode = "source-tracked" | "edited-in-pagecast";
export type BuildStatus = "idle" | "building" | "ready" | "failed";

export interface Report {
  id: string;
  name: string;
  kind: ReportKind;
  sourcePath: string | null;
  order: number;
  autoSync: boolean;
  sourceMode: SourceMode;
  buildCommand: string;
  buildOutputDir: string;
  buildStatus: BuildStatus;
  buildError: string;
  lastBuildAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Admin preview URL (/preview/:id/) — iframe src.
  localUrl: string | null;
  // Latest active snapshot public URL, or null.
  publicUrl: string | null;
  publications: Publication[];
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareStatus {
  authMode: "api-token" | "scoped-oauth";
  tokenConfigured: boolean;
  accountIdConfigured: boolean;
  accountId: string;
  scopedOauthAvailable: boolean;
  oauthScopes: string[];
  loggedIn: boolean;
  accounts: CloudflareAccount[];
  accountName: string;
  projectName: string;
  baseUrl: string;
}

export interface PagesConfig {
  projectName: string;
  accountId: string;
  accountName: string;
  branch: string;
  baseUrl: string;
}

export interface FeedbackConfig {
  url: string;
  statsToken: string;
  workerName: string;
  kvId: string;
}

export interface AppConfig {
  pages: PagesConfig;
  feedback: FeedbackConfig | null;
  badge: boolean;
}

export interface FeedbackStats {
  views: number;
  reactions: Record<string, number>;
  countries: Record<string, number>;
  referrers: Record<string, number>;
  devices: Record<string, number>;
}

export interface FeedbackStatsResponse {
  ok: boolean;
  configured: boolean;
  slug?: string;
  stats: FeedbackStats | null;
}

export interface FeedbackSetupResponse {
  config: AppConfig;
  feedback: FeedbackConfig | null;
}

export interface StatusResponse {
  admin: { ok: boolean };
  public: { localBaseUrl: string | null };
  cloudflare: CloudflareStatus;
  config: AppConfig;
}

export interface ReportsResponse {
  reports: Report[];
}

export interface ReportResponse {
  report: Report;
}

export interface PublishResponse {
  report: Report;
  publication: Publication;
}

export interface ContentResponse {
  html: string;
}

export interface ApiErrorBody {
  error: {
    message: string;
    statusCode: number;
  };
}
