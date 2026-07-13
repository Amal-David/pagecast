import { createHash } from "node:crypto";
import path from "node:path";

import { appError } from "./app-error.js";

function digest(label, value) {
  return createHash("sha256")
    .update(`${label}\0${String(value || "")}`, "utf8")
    .digest("hex");
}

function firstContext(contextId, env = {}) {
  const candidates = [
    ["explicit", contextId],
    ["PAGECAST_CONTEXT_ID", env.PAGECAST_CONTEXT_ID],
    ["CODEX_THREAD_ID", env.CODEX_THREAD_ID],
    ["CLAUDE_SESSION_ID", env.CLAUDE_SESSION_ID]
  ];
  for (const [source, value] of candidates) {
    if (typeof value === "string" && value.trim()) {
      return { source, value: value.trim(), matched: true };
    }
  }
  return null;
}

function normalizedItemIdentity({ itemKey, sourcePath }) {
  if (typeof itemKey === "string" && itemKey.trim()) {
    return `item:${itemKey.trim()}`;
  }
  if (typeof sourcePath === "string" && sourcePath.trim()) {
    return `source:${path.resolve(sourcePath)}`;
  }
  return "item:anonymous";
}

export function resolvePublicationContext({
  contextId = "",
  workspaceId = "",
  itemKey = "",
  sourcePath = "",
  env = process.env
} = {}) {
  const itemIdentity = normalizedItemIdentity({ itemKey, sourcePath });
  const workspaceHash = digest("pagecast-workspace", workspaceId || "default");
  const itemHash = digest("pagecast-item", itemIdentity);
  const selected = firstContext(contextId, env);
  const fallbackValue = `${workspaceHash}\0${itemHash}`;
  const contextHash = digest(
    "pagecast-agent-context",
    selected ? selected.value : fallbackValue
  );
  return {
    source: selected?.source || "workspace-source",
    contextMatched: selected?.matched === true,
    contextHash,
    itemHash,
    workspaceHash,
    contextKey: digest(
      "pagecast-publication-context",
      `${workspaceHash}\0${itemHash}\0${contextHash}`
    )
  };
}

export function normalizePublishMode({ mode = "", newLink = false, update = "" } = {}) {
  const requestedMode = String(mode || "").trim().toLowerCase();
  const publication = String(update || "").trim();
  const wantsNew = newLink === true || requestedMode === "new";
  const wantsUpdate = Boolean(publication) || requestedMode === "update";
  if (wantsNew && wantsUpdate) {
    throw appError("Choose either a new link or an existing publication to update.", 400);
  }
  if (requestedMode && !["upsert", "new", "update"].includes(requestedMode)) {
    throw appError("Publish mode must be upsert, new, or update.", 400);
  }
  if (wantsUpdate && !publication) {
    throw appError("Update mode requires an existing publication URL, slug, or token.", 400);
  }
  return {
    mode: wantsNew ? "new" : wantsUpdate ? "update" : requestedMode || "upsert",
    publication
  };
}

function publicationReferences(publication) {
  const values = new Set(
    [publication?.token, publication?.slug, publication?.publicUrl]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().replace(/\/+$/, ""))
  );
  if (publication?.publicUrl) {
    try {
      const match = /^\/p\/([^/]+)\/?$/.exec(new URL(publication.publicUrl).pathname);
      if (match) values.add(decodeURIComponent(match[1]));
    } catch {
      // Stored public URLs are validated elsewhere; ignore malformed legacy data.
    }
  }
  return values;
}

export function findPublicationForPublish(
  reports,
  { mode = "upsert", contextKey = "", publication = "" } = {}
) {
  if (mode === "new") return null;
  const reference = String(publication || "").trim().replace(/\/+$/, "");
  for (const report of reports || []) {
    for (const candidate of report?.publications || []) {
      if (candidate?.revokedAt) continue;
      if (mode === "upsert" && contextKey && candidate.contextKey === contextKey) {
        return { report, publication: candidate };
      }
      if (mode === "update" && reference && publicationReferences(candidate).has(reference)) {
        return { report, publication: candidate };
      }
    }
  }
  if (mode === "update") {
    throw appError("The requested Pagecast publication was not found or is no longer active.", 404);
  }
  return null;
}
