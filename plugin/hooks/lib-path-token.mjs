const TOKEN_PREFIX = "pcp1.";

export function encodePathToken(filePath) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) {
    throw new Error("A non-empty file path is required to create a path token.");
  }
  return `${TOKEN_PREFIX}${Buffer.from(filePath, "utf8").toString("base64url")}`;
}
