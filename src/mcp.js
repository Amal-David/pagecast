import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  MAX_UPLOAD_BYTES,
  addCloudflarePagesDomain,
  appError,
  createReportStore,
  getCloudflarePagesDomain,
  getCloudflarePagesStatus,
  publishReportSnapshot,
  removeCloudflarePagesDomain,
  revokeReportPublication
} from "./server.js";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";
const CONTENT_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown"]);

class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error?.message || String(error)
      }
    ]
  };
}

function requiredString(args, name) {
  const value = args?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw appError(`\`${name}\` is required.`, 400);
  }
  return value.trim();
}

function requiredContent(args) {
  const value = args?.content;
  if (typeof value !== "string" || !value.trim()) {
    throw appError("`content` is required.", 400);
  }
  return value;
}

function optionalString(args, name) {
  const value = args?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function optionalBoolean(args, name) {
  return args?.[name] === true;
}

function normalizeContentFileName({ filename, format }) {
  const requestedFormat = String(format || "").trim().toLowerCase();
  const defaultExtension = requestedFormat === "markdown" || requestedFormat === "md" ? ".md" : ".html";
  const rawBase = path.basename(String(filename || `pagecast-mcp-content${defaultExtension}`).trim());
  const extension = path.extname(rawBase).toLowerCase() || defaultExtension;
  if (!CONTENT_EXTENSIONS.has(extension)) {
    throw appError("Content filename must end in .html, .htm, .md, or .markdown.", 400);
  }
  const name = path.basename(rawBase, path.extname(rawBase)).replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${name || "pagecast-mcp-content"}${extension}`;
}

async function writeMcpContentFile({ dataDir, content, filename, format, itemKey = "" }) {
  if (typeof content !== "string" || !content.trim()) {
    throw appError("`content` is required.", 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_UPLOAD_BYTES) {
    throw appError("Content is too large for MCP publishing.", 413);
  }
  const safeName = normalizeContentFileName({ filename, format });
  const itemDigest = itemKey
    ? createHash("sha256").update(String(itemKey), "utf8").digest("hex")
    : "";
  const contentDir = itemDigest
    ? path.join(dataDir, "mcp-content", "items", itemDigest)
    : path.join(dataDir, "mcp-content", `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(contentDir, { recursive: true });
  const filePath = path.join(contentDir, safeName);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

function normalizeToolArguments(params) {
  const args = isObject(params?.arguments) ? params.arguments : {};
  return args;
}

function summarizeStatus(status) {
  const cloudflare = status?.cloudflare || {};
  return {
    configured: Boolean(cloudflare.loggedIn || cloudflare.tokenConfigured),
    loggedIn: Boolean(cloudflare.loggedIn),
    tokenConfigured: Boolean(cloudflare.tokenConfigured),
    projectName: cloudflare.projectName || "",
    baseUrl: cloudflare.baseUrl || "",
    managed: Boolean(cloudflare.managed),
    requiresAdoption: Boolean(cloudflare.requiresAdoption)
  };
}

// An allowlist like summarizeStatus: the service result carries the full public
// config, and an agent only needs the domain's own state.
function summarizeDomain(result) {
  const domain = result?.customDomain || null;
  return {
    domain: domain?.name || "",
    status: domain?.status || "none",
    // The origin links actually use right now, which is the pages.dev one until
    // Cloudflare reports the domain active.
    publicBaseUrl: result?.publicBaseUrl || "",
    active: domain?.status === "active",
    error: domain?.error || "",
    dns: result?.dns?.instructions || "",
    requiresCloudflareZone: Boolean(result?.dns?.requiresCloudflareZone),
    rebasedLinks: result?.rebased || 0,
    // Live pages whose baked social metadata still names the previous origin.
    staleMetadata: result?.staleMetadata || 0,
    // Which of Cloudflare's two checks a pending domain is still waiting on:
    // `validation` is DNS, `verification` is the certificate. Without these an
    // agent can only report "still pending" and cannot say what to fix.
    validation: result?.progress?.validation || "",
    verification: result?.progress?.verification || "",
    // Domains attached to the same Pages project that Pagecast does not track.
    // Adding one by name adopts it, so this is an actionable list.
    unadopted: result?.unadopted || [],
    // The tracked domain vanished from Cloudflare between calls; links have
    // already fallen back to the pages.dev origin.
    removedRemotely: result?.removedRemotely || ""
  };
}

function summarizePublication(publication) {
  return {
    token: publication.token,
    slug: publication.slug,
    label: publication.label,
    kind: publication.kind,
    linkKind: publication.linkKind,
    active: publication.active,
    publicUrl: publication.publicUrl,
    expiresAt: publication.expiresAt,
    expired: publication.expired,
    revokedAt: publication.revokedAt
  };
}

function summarizeReport(report) {
  return {
    id: report.id,
    name: report.name,
    kind: report.kind,
    publicUrl: report.publicUrl,
    passwordProtected: report.passwordProtected,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    publications: (report.publications || []).map(summarizePublication)
  };
}

function publishContextOptions(args, { workspaceId, itemKey, forceNew = false } = {}) {
  const mode = optionalString(args, "mode") || "upsert";
  const publication = optionalString(args, "publication");
  return {
    contextId: optionalString(args, "contextId"),
    workspaceId,
    itemKey,
    mode: forceNew ? "new" : mode,
    newLink: forceNew || mode === "new",
    update: mode === "update" ? publication : ""
  };
}

async function publishIsolatedFile({
  dataDir,
  workspaceId,
  filePath,
  args,
  publishFile,
  writeContentFile
}) {
  normalizeContentFileName({ filename: path.basename(filePath) });
  const content = await fs.readFile(filePath, "utf8");
  const isolatedPath = await writeContentFile({
    dataDir,
    content,
    filename: path.basename(filePath),
    itemKey: optionalString(args, "itemKey") || path.resolve(filePath)
  });
  const result = await publishFile({
    path: isolatedPath,
    label: optionalString(args, "label") || path.basename(filePath),
    password: optionalString(args, "password"),
    disableProtection: optionalBoolean(args, "noPassword"),
    expires: optionalString(args, "expires"),
    ...publishContextOptions(args, {
      workspaceId,
      itemKey: optionalString(args, "itemKey") || path.resolve(filePath)
    }),
    dataDir
  });
  return { ...result, sourcePath: isolatedPath, includedAssets: false };
}

function toolDefinitions() {
  return [
    {
      name: "status",
      title: "Pagecast Status",
      description: "Show Pagecast Cloudflare Pages configuration and sign-in state.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          verbose: { type: "boolean", description: "Return full local config metadata instead of a redacted summary." }
        }
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    {
      name: "list_pages",
      title: "List Pagecast Pages",
      description: "List locally known Pagecast reports and published links.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          verbose: { type: "boolean", description: "Include local source paths and build settings." }
        }
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    {
      name: "publish_file",
      title: "Publish File",
      description: "Publish a local HTML or Markdown file with Pagecast. Sibling assets are excluded unless explicitly requested.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Absolute path to an HTML or Markdown file." },
          label: { type: "string", description: "Optional Pagecast display label." },
          expires: { type: "string", description: "Expiry such as 7d, 12h, or never." },
          password: { type: "string", description: "Optional password for edge protection." },
          noPassword: { type: "boolean", description: "Remove existing password protection for this file." },
          includeAssets: { type: "boolean", description: "Publish sibling assets from the file's folder." },
          confirmAssets: {
            type: "boolean",
            description: "Must be true with includeAssets because sibling files may become public."
          },
          mode: { type: "string", enum: ["upsert", "new", "update"], description: "Update the matching agent-context link, create a new link, or update a known publication." },
          contextId: { type: "string", description: "Optional agent session or conversation identifier; Pagecast stores only its hash." },
          publication: { type: "string", description: "Existing URL, slug, or token required by update mode." },
          itemKey: { type: "string", description: "Stable logical item key; defaults to the absolute source path." }
        }
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    {
      name: "publish_content",
      title: "Publish Content",
      description: "Write HTML or Markdown content into Pagecast storage and publish it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
          content: { type: "string", description: "HTML or Markdown content to publish." },
          filename: { type: "string", description: "Optional filename ending in .html, .htm, .md, or .markdown." },
          format: { type: "string", enum: ["html", "markdown"], description: "Used to choose a default extension." },
          label: { type: "string", description: "Optional Pagecast display label." },
          expires: { type: "string", description: "Expiry such as 7d, 12h, or never." },
          password: { type: "string", description: "Optional password for edge protection." },
          noPassword: { type: "boolean", description: "Remove existing password protection for this content filename." },
          mode: { type: "string", enum: ["upsert", "new", "update"], description: "Update the matching agent-context link, create a new link, or update a known publication." },
          contextId: { type: "string", description: "Optional agent session or conversation identifier; Pagecast stores only its hash." },
          publication: { type: "string", description: "Existing URL, slug, or token required by update mode." },
          itemKey: { type: "string", description: "Stable logical item key for deterministic content upserts." }
        }
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    {
      name: "revoke_publication",
      title: "Revoke Publication",
      description: "Revoke a Pagecast publication token and redeploy the Pages site.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["token", "confirm"],
        properties: {
          token: { type: "string", description: "Pagecast publication token." },
          confirm: { type: "boolean", description: "Must be true because this takes a live link offline." }
        }
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    {
      name: "custom_domain",
      title: "Custom Domain",
      description:
        "Show, attach, or detach the custom domain that Pagecast links use. " +
        "Without an action this reconciles against Cloudflare and reports DNS and certificate progress.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["status", "add", "remove"],
            description: "Defaults to status."
          },
          domain: {
            type: "string",
            description: "Hostname to attach. Required for add; optional for remove."
          }
        }
      },
      annotations: {
        readOnlyHint: false,
        // Attaching a domain does not take any link offline; removing one only
        // reverts links to the pages.dev origin, which keeps serving.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    }
  ];
}

export function createPagecastMcpServer({
  dataDir = path.join(process.cwd(), ".pagecast"),
  workspaceId = dataDir,
  version = "0.0.0",
  getStatus = getCloudflarePagesStatus,
  publishFile = publishReportSnapshot,
  revokePublication = revokeReportPublication,
  addDomain = addCloudflarePagesDomain,
  getDomain = getCloudflarePagesDomain,
  removeDomain = removeCloudflarePagesDomain,
  createStore = createReportStore,
  writeContentFile = writeMcpContentFile
} = {}) {
  async function listPages() {
    const store = createStore({ dataDir });
    // MCP reads can run beside the dashboard process. They must not create
    // directories, persist migrations, or otherwise become a second writer.
    // A later leased writer will durably apply any in-memory normalization.
    await store.init({ persist: false });
    return { reports: store.list({}) };
  }

  async function readResource(uri) {
    if (uri === "pagecast://status") {
      return summarizeStatus(await getStatus({ dataDir }));
    }
    if (uri === "pagecast://pages") {
      const pages = await listPages();
      return { reports: pages.reports.map(summarizeReport) };
    }
    throw new JsonRpcError(-32602, `Unknown resource: ${uri}`);
  }

  async function callTool(name, args) {
    if (name === "status") {
      const status = await getStatus({ dataDir });
      return textResult(args.verbose === true ? status : summarizeStatus(status));
    }
    if (name === "list_pages") {
      const pages = await listPages();
      return textResult(args.verbose === true ? pages : { reports: pages.reports.map(summarizeReport) });
    }
    if (name === "publish_file") {
      if (args.password && args.noPassword) {
        throw appError("Use either `password` or `noPassword`, not both.", 400);
      }
      const filePath = requiredString(args, "path");
      if (args.includeAssets === true && args.confirmAssets !== true) {
        throw appError("Set `confirmAssets: true` with `includeAssets` because sibling files may become public.", 400);
      }
      if (args.includeAssets !== true) {
        return textResult(
          await publishIsolatedFile({
            dataDir,
            workspaceId,
            filePath,
            args,
            publishFile,
            writeContentFile
          })
        );
      }
      const result = await publishFile({
        path: filePath,
        label: optionalString(args, "label"),
        password: optionalString(args, "password"),
        disableProtection: optionalBoolean(args, "noPassword"),
        expires: optionalString(args, "expires"),
        ...publishContextOptions(args, {
          workspaceId,
          itemKey: optionalString(args, "itemKey") || path.resolve(filePath)
        }),
        dataDir
      });
      return textResult({ ...result, includedAssets: true });
    }
    if (name === "publish_content") {
      if (args.password && args.noPassword) {
        throw appError("Use either `password` or `noPassword`, not both.", 400);
      }
      const filePath = await writeContentFile({
        dataDir,
        content: requiredContent(args),
        filename: optionalString(args, "filename"),
        format: optionalString(args, "format"),
        itemKey: optionalString(args, "itemKey")
      });
      const itemKey = optionalString(args, "itemKey");
      const requestedMode = optionalString(args, "mode") || "upsert";
      const forceNew = requestedMode === "upsert" && !itemKey;
      const result = await publishFile({
        path: filePath,
        label: optionalString(args, "label") || path.basename(filePath),
        password: optionalString(args, "password"),
        disableProtection: optionalBoolean(args, "noPassword"),
        expires: optionalString(args, "expires"),
        ...publishContextOptions(args, { workspaceId, itemKey, forceNew }),
        dataDir
      });
      return textResult({ ...result, sourcePath: filePath });
    }
    if (name === "revoke_publication") {
      if (args.confirm !== true) {
        throw appError("Set `confirm: true` to revoke a live Pagecast link.", 400);
      }
      const result = await revokePublication({
        token: requiredString(args, "token"),
        dataDir
      });
      return textResult({
        report: summarizeReport(result.report),
        publication: summarizePublication(result.publication)
      });
    }
    if (name === "custom_domain") {
      const action = optionalString(args, "action") || "status";
      if (action === "add") {
        return textResult(
          summarizeDomain(await addDomain({ domain: requiredString(args, "domain"), dataDir }))
        );
      }
      if (action === "remove") {
        return textResult(
          summarizeDomain(await removeDomain({ domain: optionalString(args, "domain") || "", dataDir }))
        );
      }
      if (action !== "status") {
        throw appError("`action` must be status, add, or remove.", 400);
      }
      return textResult(summarizeDomain(await getDomain({ dataDir })));
    }
    throw new JsonRpcError(-32601, `Unknown tool: ${name}`);
  }

  function success(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  function failure(id, error) {
    const code = Number.isInteger(error?.code) ? error.code : -32000;
    const payload = {
      code,
      message: error?.message || String(error)
    };
    if (error?.data !== undefined) {
      payload.data = error.data;
    }
    return { jsonrpc: "2.0", id: id ?? null, error: payload };
  }

  async function handleOne(message) {
    if (!isObject(message)) {
      return failure(null, new JsonRpcError(-32600, "Invalid JSON-RPC message."));
    }

    const id = Object.hasOwn(message, "id") ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : "";
    const params = isObject(message.params) ? message.params : {};
    const isNotification = id === undefined;

    try {
      if (method === "notifications/initialized") {
        return null;
      }
      if (!method) {
        throw new JsonRpcError(-32600, "JSON-RPC method is required.");
      }
      if (method === "initialize") {
        return success(id, {
          protocolVersion:
            typeof params.protocolVersion === "string" && params.protocolVersion
              ? params.protocolVersion
              : DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false }
          },
          serverInfo: {
            name: "pagecast",
            version
          }
        });
      }
      if (method === "ping") {
        return success(id, {});
      }
      if (method === "tools/list") {
        return success(id, { tools: toolDefinitions() });
      }
      if (method === "tools/call") {
        const name = requiredString(params, "name");
        try {
          return success(id, await callTool(name, normalizeToolArguments(params)));
        } catch (error) {
          if (error instanceof JsonRpcError) {
            throw error;
          }
          return success(id, errorResult(error));
        }
      }
      if (method === "resources/list") {
        return success(id, {
          resources: [
            {
              uri: "pagecast://status",
              name: "Pagecast status",
              mimeType: "application/json"
            },
            {
              uri: "pagecast://pages",
              name: "Pagecast pages",
              mimeType: "application/json"
            }
          ]
        });
      }
      if (method === "resources/read") {
        const uri = requiredString(params, "uri");
        return success(id, {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(await readResource(uri), null, 2)
            }
          ]
        });
      }
      throw new JsonRpcError(-32601, `Method not found: ${method}`);
    } catch (error) {
      if (isNotification) {
        return null;
      }
      return failure(id, error);
    }
  }

  async function handleJsonRpc(message) {
    if (Array.isArray(message)) {
      const responses = (await Promise.all(message.map((entry) => handleOne(entry)))).filter(Boolean);
      return responses.length > 0 ? responses : null;
    }
    return handleOne(message);
  }

  return {
    handleJsonRpc,
    callTool,
    listTools: toolDefinitions
  };
}

export function startMcpStdioServer(options = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    server: providedServer
  } = options;
  const server = providedServer || createPagecastMcpServer(options);
  let buffer = "";
  let queue = Promise.resolve();

  return new Promise((resolve, reject) => {
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        queue = queue.then(() => handleLine(trimmed), () => handleLine(trimmed));
        void queue.catch(reject);
      }
    });
    input.on("end", () => {
      queue.then(resolve, reject);
    });
    input.on("error", reject);
  });

  async function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: error.message || "Parse error" }
        })}\n`
      );
      return;
    }

    const response = await server.handleJsonRpc(message);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
