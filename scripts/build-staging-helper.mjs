import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const platforms = [["darwin", "arm64"], ["darwin", "amd64"], ["linux", "arm64"], ["linux", "amd64"], ["windows", "arm64"], ["windows", "amd64"]];
const targets = process.argv.includes("--host")
  ? [[process.platform === "win32" ? "windows" : process.platform, process.arch === "x64" ? "amd64" : process.arch]]
  : platforms;
for (const [os, arch] of targets) {
  if (!platforms.some(([supportedOs, supportedArch]) => supportedOs === os && supportedArch === arch)) {
    throw new Error(`Safe staging cleanup is unsupported on ${os}/${arch}.`);
  }
  const directory = path.join(projectRoot, "native", "bin", `${os}-${arch}`);
  await mkdir(directory, { recursive: true });
  const binary = path.join(directory, `staging-remove${os === "windows" ? ".exe" : ""}`);
  const result = spawnSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", binary, "."], {
    cwd: path.join(projectRoot, "native", "staging-remove"),
    env: { ...process.env, GOTOOLCHAIN: "go1.27.2", CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
