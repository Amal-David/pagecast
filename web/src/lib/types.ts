// Types mirror the exact JSON shapes emitted by src/server.js. Do not invent
// fields: formatReport / formatPublication / /api/status are the source of truth.

export type PublicationKind = "snapshot";

export interface Publication {
  token: string;
  slug: string;
  label: string;
  kind: PublicationKind;
  // True when published as a public "drop": a short, memorable, guessable slug.
  // False (default) means a long, hard-to-guess private slug.
  drop: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  // Absolute link expiry (epoch ms) or null = Never/permanent.
  expiresAt: number | null;
  // True once the expiry has passed; the link reads as inactive (edge 410).
  expired: boolean;
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
  passwordProtected: boolean;
  importedFromCloudflare: boolean;
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

// A Cloudflare Pages deployment snapshot (one immutable, whole-site deploy).
// Mirrors the shape flagged by flagLiveDeployment in src/server.js.
export interface Deployment {
  id: string;
  shortId: string;
  url: string;
  environment: string;
  branch: string;
  createdOn: string;
  modifiedOn: string;
  // Human-friendly age/stage (e.g. "2 days ago") for display when no ISO
  // createdOn is available.
  status: string;
  latestStage: string;
  isSkipped: boolean;
  aliases: string[];
  // The currently-live production deploy; protected from deletion.
  isLive: boolean;
}

export interface DeploymentsResponse {
  deployments: Deployment[];
  projectName: string;
  baseUrl: string;
  configured: boolean;
}

export interface DeleteDeploymentResponse {
  deleted: boolean;
  id: string;
}

export interface PruneDeploymentsResponse {
  pruned: number;
  kept: number;
  deleted: string[];
  failed: { id: string; error: string }[];
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

export interface LocalConfig {
  hostname: string;
  adminPort: number;
  publicPort: number;
}

export interface AppConfig {
  pages: PagesConfig;
  feedback: FeedbackConfig | null;
  local: LocalConfig;
  badge: boolean;
  // Default link lifetime for new publishes ("30d" out of the box, "never" =
  // permanent). A per-publish expiry overrides it.
  defaultExpiry: string;
  // When true, the dashboard periodically imports missing Pagecast links from
  // Cloudflare Pages. Manual sync is still available when this is off.
  cloudflareSyncEnabled: boolean;
}

export interface ConfigResponse {
  config: AppConfig;
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

export interface CloudflareSyncResponse {
  imported: Report[];
  importedCount: number;
  skipped: { slug: string; reason: string }[];
  skippedCount: number;
  failed: { slug: string; error: string }[];
  warnings: string[];
  remoteManifestFound: boolean;
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
