import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Worker dashboard uses fixed, encoded API targets instead of a browser control proxy", async () => {
  const api = await source("web/src/lib/api.ts");
  assert.match(api, /createWorkerGrant:.*encodeURIComponent\(token\)/s);
  assert.match(api, /retryWorkerDelivery:.*encodeURIComponent\(webhookId\).*encodeURIComponent\(deliveryId\)/s);
  assert.match(api, /workerJobAction:.*encodeURIComponent\(jobId\).*\$\{action\}/s);
  assert.doesNotMatch(api, /workerControl/);
});

test("Worker dashboard keeps credentials ephemeral and refreshes direct and agent changes together", async () => {
  const hooks = await source("web/src/hooks/use-worker-publication.ts");
  const panel = await source("web/src/components/worker-publication-panel.tsx");
  assert.match(hooks, /gcTime: 0/);
  assert.match(hooks, /invalidateQueries\(\{ queryKey: workerKeys\.publication\(token\) \}\)/);
  assert.match(hooks, /refetchInterval: 30_000/);
  assert.match(panel, /const selectTab = \(next: typeof selectedTab, focus = false\) => \{\s+setCredential\(""\);\s+setTab\(next\.id\);/);
  assert.doesNotMatch(panel, /window\.(prompt|confirm|location\.reload)/);
  assert.doesNotMatch(panel, /<pre/);
});

test("Worker dashboard fetches only the active overview section and delivery history on demand", async () => {
  const server = await source("src/server.js");
  const api = await source("web/src/lib/api.ts");
  const hooks = await source("web/src/hooks/use-worker-publication.ts");
  const panel = await source("web/src/components/worker-publication-panel.tsx");
  assert.match(api, /overview\?section=\$\{encodeURIComponent\(section\)\}/);
  assert.match(hooks, /overview: \(token: string, section: WorkerOverviewSection\).*"overview", section/s);
  assert.match(hooks, /useWorkerWebhookDeliveries/);
  assert.match(panel, /section: null/);
  assert.match(panel, /<WebhookDeliveryHistory token=\{publication\.token\} webhookId=\{id\}/);
  assert.doesNotMatch(server, /deliveriesByWebhook/);
  assert.match(server, /const resources = \{/);
  assert.match(server, /versions: \(\) => \[read\("versions"/);
  assert.match(server, /automations: \(\) => \[read\("webhooks"/);
  assert.match(server, /resources\[section\]\(\)/);
});

test("Worker dashboard tab and action contracts use stable ids and server fields", async () => {
  const panel = await source("web/src/components/worker-publication-panel.tsx");
  assert.match(panel, /id: "versions"/);
  assert.match(panel, /id=\{`\$\{id\}-tab-\$\{item\.id\}`\}/);
  assert.match(panel, /event\.key === "Home"/);
  assert.match(panel, /event\.key === "End"/);
  assert.match(panel, /tabRefs\.current\[tabs\.indexOf\(next\)\]\?\.focus\(\)/);
  assert.match(panel, /hook\.disabledAt/);
  assert.match(panel, /item\.resolvedAt/);
  assert.match(panel, /status === "queued" \|\| status === "retrying"/);
  assert.match(panel, /status === "failed" \|\| status === "dead_lettered" \|\| status === "cancelled"/);
});

test("Worker dashboard exposes migration recovery, audit pagination, and unchanged Pages default", async () => {
  const api = await source("web/src/lib/api.ts");
  const panel = await source("web/src/components/worker-publication-panel.tsx");
  const picker = await source("web/src/components/delivery-picker.tsx");
  assert.match(api, /workerAudit:.*cursor/s);
  assert.match(panel, /Load older audit entries/);
  assert.match(panel, /Pages URL remains live/);
  assert.match(picker, /Cloudflare Pages is the default/);
  assert.match(picker, /Choose Worker delivery/);
});

test("Worker rows keep Pages-only controls out and surface the bounded status projection", async () => {
  const row = await source("web/src/components/publication-row.tsx");
  const connection = await source("web/src/components/worker-connection-card.tsx");
  const server = await source("src/server.js");
  assert.match(row, /const isPagesSnapshot = !isWorker && isSnapshot/);
  assert.match(row, /\{!isWorker \? <Button/);
  assert.match(connection, /Deploy Pagecast Worker/);
  assert.match(connection, /external operator setup step/);
  assert.match(connection, /D1: \{bindingLabel/);
  assert.match(server, /This is a Worker publication\. Use its Worker delivery controls instead\./);
  assert.match(server, /WORKER_BINDING_NAMES/);
  assert.match(server, /normalizeWorkerHealth/);
});

test("Worker health failures refresh the persisted safe status instead of leaving stale success UI", async () => {
  const hooks = await source("web/src/hooks/use-worker-publication.ts");
  assert.match(hooks, /useWorkerHealthAction[\s\S]*onSettled:[\s\S]*invalidateQueries\(\{ queryKey: workerKeys\.profile \}\)/);
});
