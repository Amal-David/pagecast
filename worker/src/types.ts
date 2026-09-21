export type JobKind =
  | "accessibility_check"
  | "cleanup"
  | "expire"
  | "index"
  | "link_check"
  | "notify"
  | "pdf"
  | "render_preview"
  | "screenshot"
  | "webhook";

export interface BrowserProvider {
  quickAction(action: "screenshot" | "pdf" | "accessibilityTree", options: { url: string }): Promise<Response>;
}

export type Env = Omit<Cloudflare.Env, "JOBS"> & {
  ADMIN_TOKEN: string;
  ANALYTICS_HMAC_KEY: string;
  ACCESS_JWT_AUDIENCE?: string;
  ACCESS_JWT_ISSUER?: string;
  ACCESS_JWKS_URL?: string;
  ANALYTICS_DAILY_EVENT_LIMIT?: string;
  ANALYTICS_GLOBAL_DAILY_EVENT_LIMIT?: string;
  COOKIE_SIGNING_KEY: string;
  MCP_ALLOWED_HOSTNAMES?: string;
  MCP_ALLOWED_ORIGIN_HOSTNAMES?: string;
  BROWSER?: BrowserProvider;
  CF_VERSION_METADATA?: { id?: string; tag?: string };
  CONTENT_ORIGIN?: string;
  PUBLIC_ORIGIN?: string;
  JOBS: Queue<JobMessage>;
  TOKEN_HASH_KEY: string;
  WEBHOOK_SIGNING_KEY: string;
};

export interface JobMessage {
  id: string;
  kind: JobKind;
  ownerId: string;
  payload: Record<string, unknown>;
}
