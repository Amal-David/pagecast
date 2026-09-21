import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const workerEnv = { ...env, ADMIN_TOKEN: "control-read-bootstrap" } as Env;
const ownerA = "owner-control-a";
const ownerB = "owner-control-b";

function read(path: string) {
  return worker.fetch!(new Request(`https://pagecast.test${path}`, {
    headers: { Authorization: "Bearer control-read-bootstrap" },
  }) as never, workerEnv, {} as ExecutionContext);
}

beforeEach(async () => {
  const schema = [
    "DROP TABLE IF EXISTS upload_session_files",
    "DROP TABLE IF EXISTS upload_sessions",
    "DROP TABLE IF EXISTS access_policies",
    "DROP TABLE IF EXISTS publications",
    `CREATE TABLE publications (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at TEXT,
      deleted_at TEXT
    )`,
    `CREATE TABLE upload_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE upload_session_files (
      session_id TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      expected_bytes INTEGER NOT NULL,
      expected_sha256 TEXT NOT NULL,
      received_bytes INTEGER,
      received_sha256 TEXT,
      PRIMARY KEY (session_id, normalized_path)
    )`,
    `CREATE TABLE access_policies (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      approval_state TEXT NOT NULL,
      auth_version INTEGER NOT NULL
    )`,
  ];
  for (const statement of schema) await env.DB.prepare(statement).run();
});

describe("owner-scoped control reads", () => {
  it("reports upload progress from the immutable file receipt columns and does not leak another owner session", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO publications (id, owner_id) VALUES (?, ?)").bind("publication-a", ownerA),
      env.DB.prepare("INSERT INTO upload_sessions (id, owner_id, publication_id, version_id, mode, status, expires_at) VALUES (?, ?, ?, 'version-a', 'create', 'open', datetime('now', '+1 day'))").bind("session-a", ownerA, "publication-a"),
      env.DB.prepare("INSERT INTO upload_session_files (session_id, normalized_path, expected_bytes, expected_sha256, received_bytes, received_sha256) VALUES ('session-a', 'one.html', 3, 'one', 3, 'one')"),
      env.DB.prepare("INSERT INTO upload_session_files (session_id, normalized_path, expected_bytes, expected_sha256, received_bytes, received_sha256) VALUES ('session-a', 'two.html', 3, 'two', 3, 'wrong')"),
      env.DB.prepare("INSERT INTO upload_session_files (session_id, normalized_path, expected_bytes, expected_sha256) VALUES ('session-a', 'three.html', 3, 'three')"),
    ]);

    const visible = await read(`/v1/owners/${ownerA}/upload-sessions/session-a`);
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({ files: { total: 3, uploaded: 1 } });

    const foreign = await read(`/v1/owners/${ownerB}/upload-sessions/session-a`);
    expect(foreign.status).toBe(404);
  });

  it("reads expiry from the owner-bound publication row and does not leak another owner's policy", async () => {
    const expiresAt = "2031-04-05T06:07:08.000Z";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO publications (id, owner_id, expires_at) VALUES (?, ?, ?)").bind("publication-a", ownerA, expiresAt),
      env.DB.prepare("INSERT INTO access_policies (id, owner_id, publication_id, mode, approval_state, auth_version) VALUES ('policy-a', ?, 'publication-a', 'password', 'approved', 7)").bind(ownerA),
    ]);

    const visible = await read(`/v1/owners/${ownerA}/publications/publication-a/access-policy`);
    expect(visible.status).toBe(200);
    expect(await visible.json()).toEqual({ mode: "password", approvalState: "approved", expiresAt, authVersion: 7 });

    const foreign = await read(`/v1/owners/${ownerB}/publications/publication-a/access-policy`);
    expect(foreign.status).toBe(404);
  });
});
