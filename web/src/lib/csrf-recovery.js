const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const STALE_CSRF_RESPONSE =
  "Forbidden: the Pagecast admin session token is missing or stale.";

function defaultSessionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function isStaleCsrfResponse(response) {
  if (response.status !== 403) {
    return false;
  }
  try {
    return (await response.clone().text()).trim() === STALE_CSRF_RESPONSE;
  } catch {
    return false;
  }
}

/**
 * Cache the current admin-session token and retry one mutation only when the
 * backend's explicit stale-token response proves that the server restarted.
 */
export function createCsrfRecovery({
  fetchImpl = globalThis.fetch,
  sessionPath = "/api/session",
  createSessionError = defaultSessionError
} = {}) {
  let csrfTokenPromise = null;

  function invalidate() {
    csrfTokenPromise = null;
  }

  async function getCsrfToken() {
    if (!csrfTokenPromise) {
      csrfTokenPromise = Promise.resolve()
        .then(() =>
          fetchImpl(sessionPath, {
            method: "GET",
            credentials: "same-origin"
          })
        )
        .then(async (response) => {
          if (!response.ok) {
            throw createSessionError(
              "Could not establish an admin session",
              response.status
            );
          }

          const session = await response.json();
          if (typeof session?.csrfToken !== "string" || !session.csrfToken) {
            throw createSessionError(
              "Admin session did not include a CSRF token",
              500
            );
          }
          return session.csrfToken;
        })
        .catch((error) => {
          invalidate();
          throw error;
        });
    }
    return csrfTokenPromise;
  }

  async function fetchWithRecovery(input, init = {}) {
    const requestHeaders = new Headers(init.headers);
    const requestInit = { ...init, headers: requestHeaders };
    const method = (requestInit.method || "GET").toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return fetchImpl(input, requestInit);
    }

    requestHeaders.set("X-Pagecast-CSRF", await getCsrfToken());
    const response = await fetchImpl(input, requestInit);
    if (!(await isStaleCsrfResponse(response))) {
      return response;
    }

    invalidate();
    requestHeaders.set("X-Pagecast-CSRF", await getCsrfToken());
    return fetchImpl(input, requestInit);
  }

  return { fetch: fetchWithRecovery, invalidate };
}
