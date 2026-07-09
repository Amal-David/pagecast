import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("the dashboard uses the server's typed recovery contract for every journal operation", async () => {
  const [types, api, hooks, app, journal] = await Promise.all([
    source("web/src/lib/types.ts"),
    source("web/src/lib/api.ts"),
    source("web/src/hooks/use-pagecast.ts"),
    source("web/src/App.tsx"),
    source("web/src/components/operation-journal.tsx")
  ]);

  assert.match(types, /export interface OperationJournalEntry/);
  for (const type of [
    "publish",
    "sync",
    "auto_sync",
    "content_sync",
    "password_sync",
    "password_compensate",
    "rename",
    "goal_sync",
    "revoke"
  ]) {
    assert.match(types, new RegExp(`\\| "${type}"`));
  }
  assert.match(types, /status:\s*"pending" \| "failed"/);
  assert.match(types, /recovery:\s*OperationRecovery/);
  assert.match(types, /attempts:\s*number/);
  assert.match(api, /getOperations:[\s\S]*\/api\/operations/);
  assert.match(api, /retryOperation:[\s\S]*\/api\/operations\/\$\{encodeURIComponent\(id\)\}\/retry/);
  assert.match(hooks, /queryKey:\s*OPERATIONS_KEY/);
  const retryHook = /export function useRetryOperation\(\) \{([\s\S]*?)\n\}/.exec(hooks);
  assert.ok(retryHook);
  assert.match(retryHook[1], /api\.retryOperation\(operation\.id\)/);
  assert.doesNotMatch(retryHook[1], /revokePublication/);
  assert.match(app, /<OperationJournal/);
  assert.match(app, /retryOperation\.variables\?\.id/);
  assert.match(journal, /Pending operations were interrupted/);
  assert.match(journal, /operation\.recovery\.mode === "automatic"/);
  assert.match(journal, /Manual action required/);
  assert.match(journal, /onClick=\{\(\) => onRetry\(operation\)\}/);
  assert.match(journal, /retryingOperationId === operation\.id/);
});

test("retry completion refreshes both reports and the durable operation journal", async () => {
  const hooks = await source("web/src/hooks/use-pagecast.ts");
  const retryHook = /export function useRetryOperation\(\) \{([\s\S]*?)\n\}/.exec(hooks);

  assert.ok(retryHook, "retry hook must remain an explicit operation workflow");
  assert.match(retryHook[1], /invalidateReports\(queryClient\)/);
  assert.match(retryHook[1], /invalidateOperations\(queryClient\)/);
  assert.match(retryHook[1], /onError:[\s\S]*invalidateOperations\(queryClient\)/);
});
