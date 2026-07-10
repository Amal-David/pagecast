const TOKEN_PREFIX = "pcp1.";
const TOKEN_PAYLOAD = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 16_384;

function invalidPathToken(message = "Invalid path token.") {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function encodePathToken(filePath) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) {
    throw invalidPathToken("A non-empty file path is required to create a path token.");
  }
  return `${TOKEN_PREFIX}${Buffer.from(filePath, "utf8").toString("base64url")}`;
}

export function decodePathToken(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !token.startsWith(TOKEN_PREFIX)) {
    throw invalidPathToken();
  }

  const payload = token.slice(TOKEN_PREFIX.length);
  if (!payload || !TOKEN_PAYLOAD.test(payload)) {
    throw invalidPathToken();
  }

  try {
    const encodedPath = Buffer.from(payload, "base64url");
    if (encodedPath.toString("base64url") !== payload) {
      throw invalidPathToken();
    }
    const filePath = new TextDecoder("utf-8", { fatal: true }).decode(encodedPath);
    if (!filePath || filePath.includes("\0")) {
      throw invalidPathToken();
    }
    return filePath;
  } catch (error) {
    if (error?.statusCode === 400) {
      throw error;
    }
    throw invalidPathToken();
  }
}

export function resolvePathArgument({ positionalPath, pathToken } = {}) {
  const hasPositionalPath = typeof positionalPath === "string" && positionalPath.length > 0;
  const hasPathToken = pathToken !== undefined && pathToken !== null;

  if (hasPositionalPath && hasPathToken) {
    throw invalidPathToken("Use either a positional path or --path-token, not both.");
  }
  if (hasPathToken) {
    return decodePathToken(pathToken);
  }
  return positionalPath;
}
