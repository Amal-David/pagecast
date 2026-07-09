import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import * as packageBoundary from "../src/index.js";
import * as legacyBoundary from "../src/server.js";

// Frozen from `origin/main:src/server.js`. This must not be derived from the
// current implementation: deleting an export from both server.js and index.js
// must fail this compatibility test.
const HISTORICAL_ROOT_EXPORTS = [
  "CLOUDFLARE_OAUTH_SCOPES",
  "DEFAULT_ADMIN_PORT",
  "DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS",
  "DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS",
  "DEFAULT_HOST",
  "DEFAULT_LOCAL_HOSTNAME",
  "DEFAULT_OG_IMAGE",
  "DEFAULT_PAGES_BRANCH",
  "DEFAULT_PAGES_PROJECT_NAME",
  "DEFAULT_PUBLIC_PORT",
  "FEEDBACK_OAUTH_SCOPES",
  "MAX_FOLDER_UPLOAD_BYTES",
  "MAX_FOLDER_UPLOAD_FILES",
  "MAX_FOLDER_UPLOAD_FILE_BYTES",
  "MAX_UPLOAD_BYTES",
  "TunnelManager",
  "appError",
  "chooseWranglerPagesProject",
  "cloudflareCredentialStatus",
  "createAdminHandler",
  "createCloudflareAuthManager",
  "createCloudflarePagesPublisher",
  "createConfigStore",
  "createDeployQueue",
  "createPublicHandler",
  "createPublicToken",
  "createReportStore",
  "createWatchManager",
  "deleteCloudflarePagesDeployment",
  "deployCloudflarePagesSite",
  "deriveReportName",
  "extensionCorsOrigin",
  "extractDescription",
  "extractPublicUrl",
  "extractTitle",
  "findKvNamespaceId",
  "flagLiveDeployment",
  "getCloudflarePagesStatus",
  "getGoalStatus",
  "injectBadge",
  "injectFeedbackWidget",
  "injectSocialMeta",
  "isLoopbackHostHeader",
  "listCloudflarePagesDeployments",
  "listCloudflarePagesProjects",
  "localHtmlPathCandidates",
  "normalizeAssetRequestPath",
  "normalizeLocalFolderPath",
  "normalizeLocalHtmlPath",
  "parseDuration",
  "parseKvNamespaceId",
  "parseMultipartFiles",
  "parseMultipartUpload",
  "parseWorkerDevUrl",
  "parseWranglerPagesDeployments",
  "parseWranglerPagesProjects",
  "parseWranglerWhoamiAccounts",
  "pruneCloudflarePagesDeployments",
  "publicTokenNamePrefix",
  "publishGoalProgress",
  "publishReportSnapshot",
  "resolveExpiresAt",
  "revokeReportPublication",
  "selectDeploymentsToPrune",
  "setupCloudflareFeedback",
  "setupCloudflarePages",
  "startServers",
  "stopGoalProgress",
  "trimPastedLocalPathInput"
].sort();

test("the package root preserves exactly the historical origin/main export surface", () => {
  assert.deepEqual(Object.keys(packageBoundary).sort(), HISTORICAL_ROOT_EXPORTS);
  for (const key of HISTORICAL_ROOT_EXPORTS) {
    assert.ok(key in legacyBoundary, `server.js compatibility facade lost ${key}`);
    assert.equal(packageBoundary[key], legacyBoundary[key], key);
  }
});

test("the package root imports from an eval-style ESM process without argv[1]", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import("pagecast").then((api) => { if (typeof api.startServers !== "function") process.exit(2) })'
    ],
    { cwd: path.resolve("."), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
