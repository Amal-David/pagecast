import { spawn } from "node:child_process";

function tunnelError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

export function extractPublicUrl(text) {
  const urls = String(text).match(/https:\/\/[^\s"'<>]+/g) || [];
  const cleanedUrls = urls.map((url) => url.replace(/[),.]+$/g, ""));
  return cleanedUrls.find((url) => /\.ts\.net/i.test(url)) || null;
}

function tunnelCommandFor(provider, localUrl) {
  if (provider === "tailscale") {
    return {
      command: "tailscale",
      args: ["funnel", "--bg", "--yes", "--https=443", localUrl],
      stopArgs: ["funnel", "--https=443", "off"],
      startupHint: "Start Tailscale and make sure Funnel is enabled for this tailnet."
    };
  }

  throw tunnelError("Pagecast is configured for Tailscale Funnel only.", 400);
}

function hasTailscaleFunnelCapability(capabilities) {
  return capabilities.some(
    (capability) =>
      capability === "funnel" ||
      capability === "https://tailscale.com/cap/funnel" ||
      capability.startsWith("https://tailscale.com/cap/funnel-ports")
  );
}

function terminateChild(child) {
  if (!child) {
    return;
  }

  const hasExited =
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
  if (hasExited) {
    return;
  }

  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    const stillRunning = child.exitCode === null || child.exitCode === undefined;
    if (stillRunning) {
      child.kill("SIGKILL");
    }
  }, 1000);
  timer.unref?.();
}

// Deprecated compatibility adapter. Managed publishing uses Cloudflare Pages;
// this remains exported for callers that still inspect or stop old tunnels.
export class TunnelManager {
  constructor({ localUrl, spawnImpl = spawn, timeoutMs = 30000 } = {}) {
    this.localUrl = localUrl;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.provider = null;
    this.publicUrl = null;
    this.startedAt = null;
    this.logs = [];
  }

  status() {
    return {
      running: Boolean(this.child || this.publicUrl),
      provider: this.provider,
      publicUrl: this.publicUrl,
      localUrl: this.localUrl,
      startedAt: this.startedAt,
      logs: this.logs.slice(-20)
    };
  }

  async start(provider = "tailscale") {
    if (this.publicUrl) {
      return this.status();
    }

    const providers = [provider === "auto" ? "tailscale" : provider];
    const errors = [];

    for (const candidate of providers) {
      try {
        return await this.startProvider(candidate);
      } catch (error) {
        errors.push(`${candidate}: ${error.message}`);
      }
    }

    throw tunnelError(`Could not start a public tunnel. ${errors.join(" ")}`, 502);
  }

  async startProvider(provider) {
    const config = tunnelCommandFor(provider, this.localUrl);
    this.logs = [];
    await this.preflightProvider(provider);
    const result = await this.runCommand(config);

    if (result.code !== 0) {
      throw tunnelError(
        this.withRecentOutput(
          `${provider} exited before returning a public URL (${result.signal || result.code}).`
        ),
        502
      );
    }

    const publicUrl = extractPublicUrl(result.output);
    if (!publicUrl) {
      throw tunnelError(this.withRecentOutput(`${provider} did not return a public URL.`), 502);
    }

    this.child = null;
    this.provider = provider;
    this.publicUrl = stripTrailingSlash(publicUrl);
    this.startedAt = nowIso();
    return this.status();
  }

  async preflightProvider(provider) {
    if (provider !== "tailscale") {
      return;
    }

    const result = await this.runCommand(
      {
        command: "tailscale",
        args: ["status", "--json"],
        startupHint: "Start Tailscale before starting a public URL."
      },
      { timeoutMs: 10000, recordLogs: false }
    );

    if (result.code !== 0) {
      throw tunnelError(`Tailscale is not running.\n${result.output.trim()}`, 502);
    }

    const status = safeJsonParse(result.output, null);
    if (!status?.Self?.ID) {
      throw tunnelError("Tailscale status did not include this device ID.", 502);
    }

    const capabilities = status.Self.Capabilities || [];
    if (!hasTailscaleFunnelCapability(capabilities)) {
      const nodeId = encodeURIComponent(status.Self.ID);
      throw tunnelError(
        `Tailscale Funnel is not enabled on this tailnet. Enable it here:\nhttps://login.tailscale.com/f/funnel?node=${nodeId}`,
        502
      );
    }
  }

  withRecentOutput(message) {
    const recent = this.logs.slice(-3).join("\n").trim();
    return recent ? `${message}\n${recent}` : message;
  }

  runCommand(config, { timeoutMs = this.timeoutMs, recordLogs = true } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      let output = "";

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        terminateChild(child);
        reject(error);
      };

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const recordOutput = (chunk) => {
        const text = chunk.toString();
        output += text;
        if (recordLogs) {
          this.logs.push(text.trim());
          this.logs = this.logs.filter(Boolean).slice(-50);
        }
      };

      const timer = setTimeout(() => {
        fail(
          tunnelError(
            this.withRecentOutput(`${config.command} did not finish within ${timeoutMs}ms.`),
            504
          )
        );
      }, timeoutMs);
      timer.unref?.();

      try {
        child = this.spawnImpl(config.command, config.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env
        });
      } catch {
        fail(tunnelError(`${config.command} could not start. ${config.startupHint}`, 502));
        return;
      }

      child.stdout?.on("data", recordOutput);
      child.stderr?.on("data", recordOutput);
      child.on("error", () => {
        fail(tunnelError(`${config.command} could not start. ${config.startupHint}`, 502));
      });
      child.on("exit", (code, signal) => {
        finish({ code, signal, output });
      });
    });
  }

  async stop() {
    if (!this.child && !this.publicUrl) {
      this.provider = null;
      this.publicUrl = null;
      this.startedAt = null;
      return this.status();
    }

    const provider = this.provider;
    const child = this.child;
    if (child) {
      terminateChild(child);
    }
    if (provider) {
      const config = tunnelCommandFor(provider, this.localUrl);
      this.logs = [];
      const result = await this.runCommand(
        { ...config, args: config.stopArgs || config.args },
        { timeoutMs: 10000 }
      );
      if (result.code !== 0) {
        throw tunnelError(
          this.withRecentOutput(
            `${provider} did not stop cleanly (${result.signal || result.code}).`
          ),
          502
        );
      }
    }

    this.child = null;
    this.provider = null;
    this.publicUrl = null;
    this.startedAt = null;
    return this.status();
  }

  async rotate(provider = "tailscale") {
    await this.stop();
    return this.start(provider);
  }
}
