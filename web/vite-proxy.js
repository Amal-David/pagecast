/**
 * Build the development-only admin proxy without weakening the runtime's
 * exact-Origin check. A browser request to Vite legitimately names Vite's
 * origin, so rewrite it only when it matches the request Host. Foreign origins
 * are intentionally left untouched for the admin server to reject.
 */
export function createAdminProxyOptions(target) {
  const adminOrigin = new URL(target).origin;

  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        const origin = request.headers.origin;
        const host = request.headers.host;
        if (typeof origin !== "string" || typeof host !== "string") {
          return;
        }

        try {
          const parsedOrigin = new URL(origin);
          if (
            (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
            parsedOrigin.host.toLowerCase() === host.toLowerCase()
          ) {
            proxyRequest.setHeader("Origin", adminOrigin);
          }
        } catch {
          // Preserve malformed/foreign input so the admin boundary rejects it.
        }
      });
    }
  };
}
