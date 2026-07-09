import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const WORKSPACE_LEASE_FILENAME = "workspace.lock";
export const RUNTIME_DESCRIPTOR_FILENAME = "runtime.json";

const JSON_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const RUNTIME_VERSION = 1;
const MAX_ACQUIRE_ATTEMPTS = 20;
// POSIX can replace one destination from concurrent rename calls, while
// Windows may return EPERM. Pagecast already has one cross-process writer; this
// queue gives concurrent in-process callers the same deterministic contract.
const atomicWriteQueues = new Map();

export class StateCoordinatorError extends Error {
  constructor(message, { code, statusCode, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "StateCoordinatorError";
    this.code = code || "PAGECAST_STATE_COORDINATOR_ERROR";
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
  }
}

function stateError(message, code, options = {}) {
  return new StateCoordinatorError(message, { code, ...options });
}

function normalizeMode(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new TypeError(`${label} must be a permission mode between 0o000 and 0o777.`);
  }
  return value;
}

function normalizeDataDir(dataDir) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("A non-empty Pagecast data directory is required.");
  }
  return path.resolve(dataDir);
}

export function workspaceLeasePath(dataDir) {
  return path.join(normalizeDataDir(dataDir), WORKSPACE_LEASE_FILENAME);
}

export function runtimeDescriptorPath(dataDir) {
  return path.join(normalizeDataDir(dataDir), RUNTIME_DESCRIPTOR_FILENAME);
}

async function ensurePrivateDirectory(directory, mode = PRIVATE_DIRECTORY_MODE) {
  await fs.mkdir(directory, { recursive: true, mode });
  await fs.chmod(directory, mode);
}

function canIgnoreSyncError(error) {
  return ["EINVAL", "ENOSYS", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code);
}

async function syncHandle(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (!canIgnoreSyncError(error)) {
      throw error;
    }
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await syncHandle(handle);
  } catch (error) {
    if (!canIgnoreSyncError(error)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function serializeJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw stateError(
      `State value could not be serialized as JSON: ${error?.message || error}`,
      "PAGECAST_STATE_SERIALIZE",
      { cause: error }
    );
  }
  if (serialized === undefined) {
    throw stateError("State value could not be serialized as JSON.", "PAGECAST_STATE_SERIALIZE");
  }
  return `${serialized}\n`;
}

function temporaryPathFor(file) {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
}

export async function atomicWriteJson(
  file,
  value,
  { mode = JSON_FILE_MODE, dirMode = PRIVATE_DIRECTORY_MODE } = {}
) {
  if (typeof file !== "string" || !file.trim()) {
    throw new TypeError("A non-empty state file path is required.");
  }
  const fileMode = normalizeMode(mode, "File mode");
  const directoryMode = normalizeMode(dirMode, "Directory mode");
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  const temporary = temporaryPathFor(destination);
  const body = serializeJson(value);
  const previousWrite = atomicWriteQueues.get(destination) || Promise.resolve();
  const write = previousWrite.catch(() => {}).then(async () => {
    let handle;
    await ensurePrivateDirectory(directory, directoryMode);
    try {
      handle = await fs.open(temporary, "wx", fileMode);
      await handle.chmod(fileMode);
      await handle.writeFile(body, "utf8");
      await syncHandle(handle);
      await handle.close();
      handle = null;
      await fs.rename(temporary, destination);
      await fs.chmod(destination, fileMode);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  });
  atomicWriteQueues.set(destination, write);
  try {
    await write;
  } finally {
    if (atomicWriteQueues.get(destination) === write) {
      atomicWriteQueues.delete(destination);
    }
  }
}

function validPid(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeCapability(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("A non-empty local command capability is required.");
  }
  return value.trim();
}

function isLoopbackHostname(value) {
  const hostname = String(value || "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function normalizeAdminUrl(value, { allowPending = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw && allowPending) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("The runtime admin URL must be a valid HTTP or HTTPS origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !isLoopbackHostname(parsed.hostname)
  ) {
    throw new TypeError("The runtime admin URL must be a local loopback HTTP or HTTPS origin.");
  }
  return parsed.origin;
}

function normalizeLeaseRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stateError("Workspace lease is corrupt.", "PAGECAST_LEASE_CORRUPT");
  }
  if (value.version !== RUNTIME_VERSION || !validPid(value.pid)) {
    throw stateError("Workspace lease is corrupt.", "PAGECAST_LEASE_CORRUPT");
  }
  if (typeof value.leaseId !== "string" || !value.leaseId) {
    throw stateError("Workspace lease is corrupt.", "PAGECAST_LEASE_CORRUPT");
  }
  return { version: RUNTIME_VERSION, pid: value.pid, leaseId: value.leaseId };
}

function normalizeRuntimeDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stateError("Runtime descriptor is corrupt.", "PAGECAST_RUNTIME_CORRUPT");
  }
  try {
    if (value.version !== RUNTIME_VERSION || !validPid(value.pid)) {
      throw new TypeError("invalid runtime version or PID");
    }
    if (typeof value.leaseId !== "string" || !value.leaseId) {
      throw new TypeError("invalid runtime lease ID");
    }
    return {
      version: RUNTIME_VERSION,
      pid: value.pid,
      adminUrl: normalizeAdminUrl(value.adminUrl, { allowPending: true }),
      capability: normalizeCapability(value.capability),
      leaseId: value.leaseId,
      role: value.role === "daemon" ? "daemon" : "operation"
    };
  } catch (error) {
    if (error?.code === "PAGECAST_RUNTIME_CORRUPT") {
      throw error;
    }
    throw stateError("Runtime descriptor is corrupt.", "PAGECAST_RUNTIME_CORRUPT", {
      cause: error
    });
  }
}

async function parseJsonFile(file, { missing = null, corruptCode, corruptLabel }) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { value: missing, raw: null };
    }
    throw error;
  }
  try {
    return { value: JSON.parse(raw), raw };
  } catch (error) {
    throw stateError(`${corruptLabel} is corrupt.`, corruptCode, { cause: error });
  }
}

export async function readRuntimeDescriptor(dataDir) {
  const file = runtimeDescriptorPath(dataDir);
  const { value } = await parseJsonFile(file, {
    corruptCode: "PAGECAST_RUNTIME_CORRUPT",
    corruptLabel: "Runtime descriptor"
  });
  return value === null ? null : normalizeRuntimeDescriptor(value);
}

export function isProcessAlive(pid) {
  if (!validPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function createExclusiveJson(file, value, mode = JSON_FILE_MODE) {
  const temporary = temporaryPathFor(file);
  let handle;
  let linked = false;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(serializeJson(value), "utf8");
    await syncHandle(handle);
    await handle.close();
    handle = null;
    await fs.link(temporary, file);
    linked = true;
    await fs.rm(temporary, { force: true });
    await fs.chmod(file, mode);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (linked) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export class WorkspaceLease {
  constructor(
    dataDir,
    { pid = process.pid, isPidAlive = isProcessAlive } = {}
  ) {
    this.dataDir = normalizeDataDir(dataDir);
    if (!validPid(pid)) {
      throw new TypeError("Workspace lease PID must be a positive integer.");
    }
    if (typeof isPidAlive !== "function") {
      throw new TypeError("isPidAlive must be a function.");
    }
    this.pid = pid;
    this.isPidAlive = isPidAlive;
    this.leasePath = workspaceLeasePath(this.dataDir);
    this.runtimePath = runtimeDescriptorPath(this.dataDir);
    this.leaseId = null;
    this.descriptor = null;
  }

  async #readLease() {
    const parsed = await parseJsonFile(this.leasePath, {
      corruptCode: "PAGECAST_LEASE_CORRUPT",
      corruptLabel: "Workspace lease"
    });
    if (parsed.value === null) {
      return { lease: null, raw: null };
    }
    return { lease: normalizeLeaseRecord(parsed.value), raw: parsed.raw };
  }

  async #removeStaleLease(lease, originalRaw) {
    if (await this.isPidAlive(lease.pid)) {
      throw stateError(
        `Pagecast workspace is already in use by process ${lease.pid}.`,
        "PAGECAST_WORKSPACE_BUSY"
      );
    }

    const current = await this.#readLease();
    if (!current.lease || current.raw !== originalRaw) {
      return false;
    }

    // The dead owner's lock remains in place while its descriptor is removed,
    // so another acquirer cannot publish a new descriptor that we then delete.
    await fs.rm(this.runtimePath, { force: true });
    try {
      await fs.unlink(this.leasePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await syncDirectory(this.dataDir);
    return true;
  }

  async acquire({ adminUrl = "", capability, role = "operation" } = {}) {
    if (this.leaseId) {
      throw stateError("This WorkspaceLease already holds the lease.", "PAGECAST_LEASE_ALREADY_HELD");
    }
    const normalizedCapability = normalizeCapability(capability);
    const normalizedAdminUrl = normalizeAdminUrl(adminUrl, { allowPending: true });
    const normalizedRole = role === "daemon" ? "daemon" : "operation";
    await ensurePrivateDirectory(this.dataDir);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const leaseId = randomBytes(16).toString("hex");
      const lease = { version: RUNTIME_VERSION, pid: this.pid, leaseId };
      try {
        await createExclusiveJson(this.leasePath, lease);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        const existing = await this.#readLease();
        if (!existing.lease) {
          continue;
        }
        await this.#removeStaleLease(existing.lease, existing.raw);
        continue;
      }

      const descriptor = {
        version: RUNTIME_VERSION,
        pid: this.pid,
        adminUrl: normalizedAdminUrl,
        capability: normalizedCapability,
        leaseId,
        role: normalizedRole
      };
      this.leaseId = leaseId;
      this.descriptor = descriptor;
      try {
        await atomicWriteJson(this.runtimePath, descriptor);
        return { ...descriptor };
      } catch (error) {
        await this.release().catch(() => {});
        throw error;
      }
    }

    throw stateError(
      "Pagecast could not acquire the workspace lease after repeated concurrent changes.",
      "PAGECAST_LEASE_CONTENDED"
    );
  }

  async #assertOwnership() {
    if (!this.leaseId || !this.descriptor) {
      throw stateError("This WorkspaceLease does not hold the lease.", "PAGECAST_LEASE_NOT_HELD");
    }
    const { lease } = await this.#readLease();
    if (!lease || lease.leaseId !== this.leaseId || lease.pid !== this.pid) {
      throw stateError("The Pagecast workspace lease is no longer owned by this process.", "PAGECAST_LEASE_LOST");
    }
  }

  async updateRuntime({ adminUrl, capability } = {}) {
    await this.#assertOwnership();
    const descriptor = {
      ...this.descriptor,
      adminUrl: normalizeAdminUrl(adminUrl),
      capability:
        capability === undefined
          ? this.descriptor.capability
          : normalizeCapability(capability)
    };
    await atomicWriteJson(this.runtimePath, descriptor);
    this.descriptor = descriptor;
    return { ...descriptor };
  }

  async release() {
    if (!this.leaseId) {
      return false;
    }
    await this.#assertOwnership();
    await fs.rm(this.runtimePath, { force: true });
    await fs.unlink(this.leasePath);
    await syncDirectory(this.dataDir);
    this.leaseId = null;
    this.descriptor = null;
    return true;
  }
}

function normalizeCommand(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("A non-empty local command name is required.");
  }
  return value.trim();
}

async function commandFailure(response) {
  let detail = "";
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await response.json();
      detail = body?.error?.message || body?.message || "";
    } else {
      detail = (await response.text()).trim();
    }
  } catch {
    detail = "";
  }
  return stateError(
    detail || `Pagecast command failed (${response.status}).`,
    "PAGECAST_COMMAND_FAILED",
    { statusCode: response.status }
  );
}

export async function tryInvokeLiveCommand(
  dataDir,
  command,
  payload = {},
  { fetchImpl = globalThis.fetch, isPidAlive = isProcessAlive } = {}
) {
  if (typeof fetchImpl !== "function" || typeof isPidAlive !== "function") {
    throw new TypeError("fetchImpl and isPidAlive must be functions.");
  }
  const descriptor = await readRuntimeDescriptor(dataDir);
  if (!descriptor) {
    return null;
  }
  if (!(await isPidAlive(descriptor.pid))) {
    return null;
  }
  if (!descriptor.adminUrl) {
    if (descriptor.role !== "daemon") {
      return null;
    }
    throw stateError(
      "The live Pagecast process has not published its admin URL yet.",
      "PAGECAST_DAEMON_NOT_READY"
    );
  }
  const body = serializeJson({ command: normalizeCommand(command), payload });
  let response;
  try {
    response = await fetchImpl(`${descriptor.adminUrl}/api/command`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Pagecast-Capability": descriptor.capability
      },
      body
    });
  } catch (error) {
    throw stateError(
      "The live Pagecast process could not be reached.",
      "PAGECAST_COMMAND_UNREACHABLE",
      { cause: error }
    );
  }

  if (!response.ok) {
    throw await commandFailure(response);
  }
  if (response.status === 204) {
    return { ok: true };
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const result = await response.json();
    return result === null ? { ok: true, result: null } : result;
  }
  return { ok: true, result: await response.text() };
}
