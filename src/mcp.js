import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  MAX_UPLOAD_BYTES,
  appError,
  createReportStore,
  getCloudflarePagesStatus,
  publishReportSnapshot,
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

async function writeMcpContentFile({ dataDir, content, filename, format }) {
  if (typeof content !== "string" || !content.trim()) {
    throw appError("`content` is required.", 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_UPLOAD_BYTES) {
    throw appError("Content is too large for MCP publishing.", 413);
  }
  const safeName = normalizeContentFileName({ filename, format });
  const contentDir = path.join(dataDir, "mcp-content", `${Date.now()}-${randomUUID()}`);
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
    baseUrl: cloudflare.baseUrl || ""
  };
}

function summarizePublication(publication) {
  return {
    token: publication.token,
    slug: publication.slug,
    label: publication.label,
    kind: publication.kind,
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

async function publishIsolatedFile({ dataDir, filePath, args, publishFile, writeContentFile }) {
  normalizeContentFileName({ filename: path.basename(filePath) });
  const content = await fs.readFile(filePath, "utf8");
  const isolatedPath = await writeContentFile({
    dataDir,
    content,
    filename: path.basename(filePath)
  });
  const result = await publishFile({
    path: isolatedPath,
    label: optionalString(args, "label") || path.basename(filePath),
    password: optionalString(args, "password"),
    disableProtection: optionalBoolean(args, "noPassword"),
    expires: optionalString(args, "expires"),
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
          }
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
          noPassword: { type: "boolean", description: "Remove existing password protection for this content filename." }
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
    }
  ];
}

export function createPagecastMcpServer({
  dataDir = path.join(process.cwd(), ".pagecast"),
  version = "0.0.0",
  getStatus = getCloudflarePagesStatus,
  publishFile = publishReportSnapshot,
  revokePublication = revokeReportPublication,
  createStore = createReportStore,
  writeContentFile = writeMcpContentFile
} = {}) {
  async function listPages() {
    const store = createStore({ dataDir });
    await store.init();
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
        format: optionalString(args, "format")
      });
      const result = await publishFile({
        path: filePath,
        label: optionalString(args, "label") || path.basename(filePath),
        password: optionalString(args, "password"),
        disableProtection: optionalBoolean(args, "noPassword"),
        expires: optionalString(args, "expires"),
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
  const server = createPagecastMcpServer(options);
  let buffer = "";

  return new Promise((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        void handleLine(trimmed);
      }
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", reject);
  });

  async function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stdout.write(
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
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}
