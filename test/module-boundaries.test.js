import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));

function relativeImports(source) {
  const dependencies = new Set();
  for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    dependencies.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm)) {
    dependencies.add(match[1]);
  }
  return [...dependencies];
}

async function sourceGraph() {
  const files = (await fs.readdir(sourceDir)).filter((file) => file.endsWith(".js"));
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const source = await fs.readFile(path.join(sourceDir, file), "utf8");
    const dependencies = relativeImports(source)
      .map((specifier) => {
        const resolved = path.normalize(path.join(path.dirname(file), specifier));
        return path.extname(resolved) ? resolved : `${resolved}.js`;
      })
      .filter((dependency) => fileSet.has(dependency));
    graph.set(file, dependencies);
  }
  return graph;
}

function findCycle(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];

  function visit(moduleName) {
    if (active.has(moduleName)) {
      const start = stack.indexOf(moduleName);
      return [...stack.slice(start), moduleName];
    }
    if (visited.has(moduleName)) {
      return null;
    }
    visited.add(moduleName);
    active.add(moduleName);
    stack.push(moduleName);
    for (const dependency of graph.get(moduleName) || []) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    active.delete(moduleName);
    return null;
  }

  for (const moduleName of graph.keys()) {
    const cycle = visit(moduleName);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

test("source modules are acyclic and server.js is the one-way composition root", async () => {
  const graph = await sourceGraph();
  assert.equal(findCycle(graph), null);

  const boundaries = [
    "admin-security.js",
    "app-error.js",
    "platform.js",
    "project-ref.js",
    "publication-service.js",
    "state-coordinator.js",
    "tunnel.js",
    "wrangler-gateway.js"
  ];
  for (const boundary of boundaries) {
    assert.ok(graph.has(boundary), `${boundary} must remain an explicit module boundary`);
    assert.equal(
      graph.get(boundary).includes("server.js"),
      false,
      `${boundary} must not depend back on the compatibility facade`
    );
  }

  const composedByServer = graph.get("server.js");
  for (const boundary of [
    "admin-security.js",
    "project-ref.js",
    "publication-service.js",
    "state-coordinator.js",
    "tunnel.js",
    "wrangler-gateway.js"
  ]) {
    assert.ok(composedByServer.includes(boundary), `server.js must compose ${boundary}`);
  }
});
