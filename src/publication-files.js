import path from "node:path";
import { promises as fs } from "node:fs";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"], [".csv", "text/csv; charset=utf-8"],
  [".pdf", "application/pdf"], [".woff2", "font/woff2"], [".woff", "font/woff"],
  [".map", "application/json; charset=utf-8"]
]);

export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

// This intentionally mirrors the existing Pages materializer: hidden entries
// and symlinks are excluded before anything becomes publishable.
export async function listPublicTreeFiles(rootDir, { maxFiles = Infinity } = {}) {
  const files = [];
  async function walk(directory, relative = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), childRelative); continue; }
      if (entry.isFile()) {
        files.push(childRelative.split(path.sep).join("/"));
        if (files.length > maxFiles) throw new RangeError("public_tree_file_limit");
      }
    }
  }
  try { await walk(rootDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return files.sort((left, right) => left.localeCompare(right));
}
