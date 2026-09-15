import { redactAuditMetadata } from "./auth";

const MAX_AUDIT_PAGE = 100;

function auditCursor(row: { occurredAt: unknown; id: unknown }): string {
  return btoa(JSON.stringify([String(row.occurredAt), String(row.id)])).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function parseAuditCursor(value: string | null): [string, string] | null {
  if (!value || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((item) => typeof item === "string") ? [parsed[0], parsed[1]] : null;
  } catch { return null; }
}

/** Owner-scoped, paginated audit projection; historical metadata is redacted again. */
export async function listRedactedAuditEvents(db: D1Database, ownerId: string, options: { limit?: string | number | null; cursor?: string | null } = {}) {
  const requested = Number(options.limit);
  const limit = Number.isInteger(requested) ? Math.min(MAX_AUDIT_PAGE, Math.max(1, requested)) : 50;
  const cursor = parseAuditCursor(options.cursor ?? null);
  const query = cursor
    ? db.prepare("SELECT id, actor_id, action, resource_type, resource_id, metadata_json, occurred_at FROM audit_events WHERE owner_id = ? AND (occurred_at < ? OR (occurred_at = ? AND id < ?)) ORDER BY occurred_at DESC, id DESC LIMIT ?").bind(ownerId, cursor[0], cursor[0], cursor[1], limit + 1)
    : db.prepare("SELECT id, actor_id, action, resource_type, resource_id, metadata_json, occurred_at FROM audit_events WHERE owner_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?").bind(ownerId, limit + 1);
  const rows = (await query.all<Record<string, unknown>>()).results;
  const events = rows.slice(0, limit).map((row) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = redactAuditMetadata(JSON.parse(String(row.metadata_json || "{}"))); } catch { /* corrupt historical record */ }
    return { id: String(row.id), actorId: row.actor_id ? String(row.actor_id) : null, action: String(row.action), resourceType: String(row.resource_type), resourceId: String(row.resource_id), metadata, occurredAt: String(row.occurred_at) };
  });
  const last = events.at(-1);
  return { events, nextCursor: rows.length > limit && last ? auditCursor(last) : "" };
}

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
