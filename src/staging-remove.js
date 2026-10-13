import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);

export async function removeStagingEntry(root, relativePath, identity) {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const executable = fileURLToPath(new URL(`../native/bin/${os}-${arch}/staging-remove${os === "windows" ? ".exe" : ""}`, import.meta.url));
  const input = JSON.stringify({ root, path: relativePath, dev: String(identity.dev), ino: String(identity.ino) });
  for (let attempt = 0; ; attempt += 1) {
    const child = execute(executable, [], { windowsHide: true, timeout: 180000, maxBuffer: 65536 });
    const sent = new Promise((resolve, reject) => {
      child.child.stdin.on("error", reject);
      child.child.stdin.end(input, resolve);
    });
    try {
      await Promise.all([child, sent]);
      return;
    } catch (error) {
      let failure;
      try { failure = JSON.parse(error.stderr); } catch { failure = { message: error.message }; }
      if (!failure.retryable || attempt === 3) {
        throw new Error(`Safe staging removal failed: ${failure.message}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 100));
    }
  }
}
