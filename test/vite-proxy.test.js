import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createAdminProxyOptions } from "../web/vite-proxy.js";

function proxyRequestHeaders(options, request) {
  const proxy = new EventEmitter();
  const rewritten = new Map();
  const proxyRequest = {
    setHeader(name, value) {
      rewritten.set(String(name).toLowerCase(), String(value));
    }
  };
  options.configure(proxy);
  proxy.emit("proxyReq", proxyRequest, request);
  return rewritten;
}

test("Vite rewrites its own browser Origin to the exact proxied admin origin", () => {
  const options = createAdminProxyOptions("http://127.0.0.1:4173");
  const headers = proxyRequestHeaders(options, {
    method: "POST",
    headers: {
      host: "localhost:5173",
      origin: "http://localhost:5173"
    }
  });

  assert.equal(options.changeOrigin, true);
  assert.equal(headers.get("origin"), "http://127.0.0.1:4173");
});

test("Vite never launders a foreign browser Origin through the admin proxy", () => {
  const options = createAdminProxyOptions("http://127.0.0.1:4173");
  const foreign = proxyRequestHeaders(options, {
    method: "POST",
    headers: {
      host: "localhost:5173",
      origin: "https://attacker.example"
    }
  });
  const absent = proxyRequestHeaders(options, {
    method: "POST",
    headers: { host: "localhost:5173" }
  });

  assert.equal(foreign.has("origin"), false);
  assert.equal(absent.has("origin"), false);
});
