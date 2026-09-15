import type { AccessIdentity } from "./access";
import type { AuthActor } from "./auth";
import type { CollaborationAction, CollaborationMutation } from "./collaboration";
import type { OperationsMutation } from "./operations";
import type { PublicationMutation } from "./publications";
import type { Env } from "./types";

export type ParsedControlJson = { payload: Record<string, unknown>; raw: string } | { tooLarge: true } | null;

/** Shared, already-authenticated control-plane dependencies for route modules. */
export interface ControlRouteContext {
  request: Request;
  env: Env;
  url: URL;
  actor: AuthActor;
  accessIdentity: AccessIdentity | null;
  error(code: string, status: number): Response;
  owns(ownerId: string): boolean;
  hasScope(scope: string): boolean;
  parseJson(): Promise<ParsedControlJson>;
  collaborationAdmin(ownerId: string): Promise<boolean>;
  collaborationAllowed(ownerId: string, action: CollaborationAction): Promise<boolean>;
  collaborationGrantAllows(ownerId: string, publicationId: string, versionId: string | null, action: CollaborationAction, required?: boolean): Promise<boolean>;
  invokeCollaborationMutation(ownerId: string, rawBody: string, mutation: CollaborationMutation): Promise<Response>;
  handlePresence(ownerId: string, publicationId: string): Promise<Response>;
  listTokens(ownerId: string): Promise<Response>;
  createToken(ownerId: string): Promise<Response>;
  revokeToken(ownerId: string, tokenId: string): Promise<Response>;
  coordinateMutation(ownerId: string): Promise<Response>;
  operationsMutation(ownerId: string, mutation: OperationsMutation): Promise<Response>;
  createUploadSession(ownerId: string): Promise<Response>;
  uploadSessionFile(ownerId: string, sessionId: string, encodedPath: string): Promise<Response>;
  completeUploadSession(ownerId: string, sessionId: string): Promise<Response>;
  updateAccessPolicy(ownerId: string, publicationId: string): Promise<Response>;
  createAccessGrant(ownerId: string, publicationId: string): Promise<Response>;
  revokeAccessGrant(ownerId: string, publicationId: string, grantId: string): Promise<Response>;
  publicationMutation(ownerId: string, mutation: PublicationMutation): Promise<Response>;
  listVersions(ownerId: string, publicationId: string): Promise<Response>;
}
