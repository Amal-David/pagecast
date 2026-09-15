export type JobKind =
  | "accessibility_check"
  | "expire"
  | "index"
  | "link_check"
  | "notify"
  | "render_preview"
  | "webhook";

export type Env = Omit<Cloudflare.Env, "JOBS"> & {
  ADMIN_TOKEN: string;
  ANALYTICS_HMAC_KEY: string;
  COOKIE_SIGNING_KEY: string;
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
