const PAGECAST_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Opaque Pagecast identifiers accepted at owner and resource boundaries. */
export function isPagecastId(value: unknown): value is string {
  return typeof value === "string" && PAGECAST_ID.test(value);
}
