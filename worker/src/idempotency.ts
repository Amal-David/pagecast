export interface IdempotencyPacket {
  fingerprint: string;
  idempotencyKey: string;
}

export interface IdempotencyReceipt {
  request_hash: string;
  response_status: number | null;
  response_body: string | null;
}

export interface IdempotencyResult {
  status: number;
  body: Record<string, unknown>;
}

export async function findIdempotencyReceipt(db: D1Database, ownerId: string, idempotencyKey: string): Promise<IdempotencyReceipt | null> {
  return db.prepare("SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?")
    .bind(ownerId, idempotencyKey).first<IdempotencyReceipt>();
}

export function resolveIdempotencyReceipt(receipt: IdempotencyReceipt, fingerprint: string): IdempotencyResult {
  if (receipt.request_hash !== fingerprint) return { status: 409, body: { error: "idempotency_key_conflict" } };
  if (receipt.response_status === null || receipt.response_body === null) return { status: 409, body: { error: "idempotency_operation_in_progress" } };
  return { status: receipt.response_status, body: JSON.parse(receipt.response_body) as Record<string, unknown> };
}

export function idempotencyReceiptStatement(
  db: D1Database,
  ownerId: string,
  packet: IdempotencyPacket,
  status: number,
  body: Record<string, unknown>,
  operationType?: string,
): D1PreparedStatement {
  if (operationType === undefined) {
    return db.prepare("INSERT INTO idempotency_keys (id, owner_id, idempotency_key, request_hash, response_status, response_body, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))")
      .bind(crypto.randomUUID(), ownerId, packet.idempotencyKey, packet.fingerprint, status, JSON.stringify(body));
  }
  return db.prepare("INSERT INTO idempotency_keys (id, owner_id, idempotency_key, request_hash, operation_type, response_status, response_body, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))")
    .bind(crypto.randomUUID(), ownerId, packet.idempotencyKey, packet.fingerprint, operationType, status, JSON.stringify(body));
}
