import { redactAuditMetadata } from "./auth";

export function auditStatement(
  db: D1Database,
  event: {
    ownerId: string;
    actorId?: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_events (id, owner_id, actor_id, action, resource_type, resource_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      event.ownerId,
      event.actorId ?? null,
      event.action,
      event.resourceType,
      event.resourceId,
      JSON.stringify(redactAuditMetadata(event.metadata ?? {})),
    );
}
