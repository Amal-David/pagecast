// Types mirror the exact JSON shapes emitted by src/server.js. Do not invent
// fields: formatReport / formatPublication / /api/status are the source of truth.

export type PublicationKind = "snapshot";
export type PublicationLinkKind = "drop" | "unlisted" | "protected" | "legacy" | "unknown";

export interface Publication {
  token: string;
  slug: string;
  label: string;
  kind: PublicationKind;
  // True when published as a public "drop": a short, memorable, guessable slug.
  // Use linkKind for the complete state; false can also represent a legacy URL.
  drop: boolean;
  linkKind: PublicationLinkKind;
  targetAttributed: boolean;
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
  sourceMissing: boolean;
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

export interface CloudflareProject {
  name: string;
  accountId: string;
  accountName: string;
  productionBranch: string;
  baseUrl: string;
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
  managed: boolean;
  requiresAdoption: boolean;
}

export type CloudflareConnectionJobStatus =
  | "preparing_wrangler"
  | "awaiting_consent"
  | "discovering_accounts"
  | "creating_home"
  | "connected"
  | "failed";

export interface CloudflareConnectionJob {
  jobId: string;
  status: CloudflareConnectionJobStatus;
  createdAt: string;
  updatedAt: string;
  authorizationUrl: string;
  requestedScopes: string[];
  projectName: string;
  baseUrl: string;
  needsAccountChoice: boolean;
  accounts: CloudflareAccount[];
  error: string;
}

// Cloudflare's lifecycle for a Pages custom domain. Only "active" means the
// hostname actually serves traffic with a valid certificate.
export type CustomDomainStatus =
  | "initializing"
  | "pending"
  | "active"
  | "deactivated"
  | "blocked"
  | "error";

export interface CustomDomain {
  name: string;
  status: CustomDomainStatus;
  addedAt: string | null;
  error: string | null;
}

export interface PagesConfig {
  projectName: string;
  accountId: string;
  accountName: string;
  branch: string;
  // The Cloudflare-assigned *.pages.dev origin. Kept distinct from the custom
  // domain because ownership verification and deploy reconciliation use it.
  baseUrl: string;
  customDomain: CustomDomain | null;
}

export interface CustomDomainDnsRecord {
  type: string;
  name: string;
  zone: string;
  value: string;
}

export interface CustomDomainResponse {
  customDomain: CustomDomain | null;
  // The origin links use right now — the pages.dev one until a domain is active.
  publicBaseUrl: string;
  originChanged: boolean;
  rebased: number;
  // Live pages whose baked social metadata still names the previous origin.
  // Only re-publishing those pages can refresh it.
  staleMetadata: number;
  dns?: {
    name: string;
    kind: "apex" | "subdomain";
    record: CustomDomainDnsRecord | null;
    requiresCloudflareZone: boolean;
    instructions: string;
  };
  // Which of Cloudflare's two checks a pending domain still waits on:
  // `validation` is DNS, `verification` is the certificate. Null once neither
  // is reported. Read from Cloudflare per call rather than stored.
  progress?: {
    validation: string;
    verification: string;
    certificateAuthority: string;
  } | null;
  // Domains on the same Pages project that Pagecast does not track. Adding one
  // by name adopts it rather than re-creating it.
  unadopted?: string[];
  // True when the add call adopted an already-attached domain.
  adopted?: boolean;
  removed?: string;
  removedRemotely?: string;
  config: AppConfig;
}

export interface FeedbackConfig {
  url: string;
  workerName: string;
  analyticsEnabled: boolean;
  reactionsEnabled: boolean;
}

export interface AnalyticsSummary {
  publicationId: string;
  views: number;
  uniqueVisitors: number;
  lastAccessAt: string | null;
}

export interface AccessEvent {
  eventId: string;
  publicationId: string;
  occurredAt: string;
  visitorId: string;
  country: string;
  region: string;
  city: string;
  asn: number | null;
  organization: string;
  device: string;
  referrerHostname: string;
}

export interface AnalyticsSummaryResponse {
  ok: boolean;
  configured: boolean;
  summaries: AnalyticsSummary[];
}

export interface AccessEventsResponse {
  ok: boolean;
  configured: boolean;
  events: AccessEvent[];
  nextCursor: string;
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
  telemetryConsent: boolean | null;
}

export interface CloudflareProjectsResponse {
  config: AppConfig;
  cloudflare: {
    authenticated: boolean;
    projects: CloudflareProject[];
    selectedProject: CloudflareProject | null;
    projectCount: number;
    managed: boolean;
    requiresAdoption: boolean;
  };
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
  instrumentation?: {
    attempted: number;
    completed: number;
    failed: { publicationToken: string; error: string }[];
  };
}

export interface StatusResponse {
  admin: { ok: boolean; product: "pagecast"; protocolVersion: 1 };
  public: { localBaseUrl: string | null };
  home: {
    suggestedProjectName: string;
    projectName: string;
    baseUrl: string;
  };
  operations: OperationJournalEntry[];
  cloudflare: CloudflareStatus;
  config: AppConfig;
}

export interface ReportsResponse {
  reports: Report[];
}

export interface ProjectRef {
  accountId: string;
  projectName: string;
  baseUrl: string;
}

export type OperationType =
  | "publish"
  | "sync"
  | "auto_sync"
  | "content_sync"
  | "password_sync"
  | "password_compensate"
  | "rename"
  | "goal_sync"
  | "revoke"
  | (string & {});

export interface OperationRecovery {
  mode: "automatic" | "manual";
  title: string;
  summary: string;
  action: string | null;
  manualReason: string | null;
}

export interface OperationJournalEntry {
  id: string;
  type: OperationType;
  token: string;
  slug: string;
  projectRef: ProjectRef | null;
  status: "pending" | "failed";
  error: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  recovery: OperationRecovery;
}

export interface OperationsResponse {
  operations: OperationJournalEntry[];
}

export interface OperationRetryResponse extends OperationsResponse {
  recovered: true;
  operationId: string;
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
