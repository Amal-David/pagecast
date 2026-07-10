"use strict";

(function exposeExtensionErrors(global) {
  const ADMIN_SESSION_ERROR = "PagecastAdminSessionError";

  function adminSessionError(status = null) {
    const error = new Error("Pagecast could not establish a local admin session.");
    error.name = ADMIN_SESSION_ERROR;
    error.status = Number.isInteger(status) ? status : null;
    return error;
  }

  function publishFailureMessage(error) {
    if (error?.name === "AbortError") {
      return "The publish timed out. Check the Pagecast terminal, then try again.";
    }
    if (error?.name === ADMIN_SESSION_ERROR) {
      const status = Number.isInteger(error.status) ? ` (${error.status})` : "";
      return `Pagecast could not establish a local admin session${status}. Restart Pagecast and reload the extension, then try again.`;
    }
    return "The connection dropped. Check the Pagecast terminal, then try again.";
  }

  global.PagecastExtensionErrors = Object.freeze({
    adminSessionError,
    publishFailureMessage
  });
})(globalThis);
