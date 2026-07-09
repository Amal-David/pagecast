export const STALE_CSRF_RESPONSE: string;

export interface CsrfRecovery {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  invalidate(): void;
}

export function createCsrfRecovery(options?: {
  fetchImpl?: typeof fetch;
  sessionPath?: string;
  createSessionError?: (message: string, statusCode: number) => Error;
}): CsrfRecovery;
