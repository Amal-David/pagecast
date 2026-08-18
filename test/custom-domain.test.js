import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyDomain,
  createCloudflareApi,
  describeDnsInstructions,
  isWranglerTokenUsable,
  normalizeCustomDomainName,
  parseWranglerCredentials,
  resolveCloudflareApiToken,
  wranglerConfigCandidates
} from "../src/cloudflare-api.js";
import { publicBaseUrl } from "../src/project-ref.js";
import { normalizePagesBaseUrl } from "../src/wrangler-gateway.js";
import {
  addCloudflarePagesDomainWithContext,
  createCloudflarePagesPublisher,
  createConfigStore,
  createReportStore,
  getCloudflarePagesDomainWithContext,
  publishReportSnapshot,
  removeCloudflarePagesDomainWithContext
} from "../src/server.js";

const TARGET = {
  accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  projectName: "alpha-reports"
};
const ASSIGNED_ORIGIN = `https://${TARGET.projectName}.pages.dev`;
const NOW = Date.parse("2026-08-02T18:00:00.000Z");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-domain-"));
}

// --- credentials -----------------------------------------------------------

test("an explicit API token wins and never invokes Wrangler", async () => {
  let refreshes = 0;
  const resolved = await resolveCloudflareApiToken({
    env: { CLOUDFLARE_API_TOKEN: "explicit-token" },
    readFile: async () => 'oauth_token = "stored"',
    refreshSession: () => {
      refreshes += 1;
    }
  });

  assert.equal(resolved.token, "explicit-token");
  assert.equal(resolved.source, "api-token");
  // Reading Wrangler's private config when a documented credential exists
  // would be a pointless dependency on its file format.
  assert.equal(refreshes, 0);
});

test("a usable stored token is not paid for with a Wrangler invocation", async () => {
  let refreshes = 0;
  const resolved = await resolveCloudflareApiToken({
    env: {},
    platform: "darwin",
    homedir: "/home",
    readFile: async () =>
      'oauth_token = "fresh"\nexpiration_time = "2026-08-02T19:00:00.000Z"',
    refreshSession: () => {
      refreshes += 1;
    },
    now: NOW
  });

  assert.equal(resolved.token, "fresh");
  assert.equal(resolved.source, "wrangler-oauth");
  assert.equal(refreshes, 0);
});

test("an expired stored token is refreshed once and re-read", async () => {
  // Wrangler's OAuth tokens live about an hour, so this is the common case,
  // not an edge case. Invoking Wrangler is what rewrites the file.
  let refreshes = 0;
  const resolved = await resolveCloudflareApiToken({
    env: {},
    platform: "darwin",
    homedir: "/home",
    readFile: async () =>
      refreshes === 0
        ? 'oauth_token = "stale"\nexpiration_time = "2026-08-02T17:00:00.000Z"'
        : 'oauth_token = "renewed"\nexpiration_time = "2026-08-02T19:00:00.000Z"',
    refreshSession: () => {
      refreshes += 1;
    },
    now: NOW
  });

  assert.equal(resolved.token, "renewed");
  assert.equal(refreshes, 1);
});

test("a stale token still resolves when the refresh itself fails", async () => {
  // Better to attempt the call and let Cloudflare's 401 explain the problem
  // than to fail locally on a refresh that might have been unnecessary.
  const resolved = await resolveCloudflareApiToken({
    env: {},
    platform: "linux",
    homedir: "/home",
    readFile: async () =>
      'oauth_token = "stale"\nexpiration_time = "2026-08-02T17:00:00.000Z"',
    refreshSession: () => Promise.reject(new Error("wrangler is not installed")),
    now: NOW
  });

  assert.equal(resolved.token, "stale");
  assert.equal(resolved.source, "wrangler-oauth");
});

test("no stored session resolves to manual setup without invoking Wrangler", async () => {
  let refreshes = 0;
  const resolved = await resolveCloudflareApiToken({
    env: {},
    platform: "darwin",
    homedir: "/home",
    readFile: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    refreshSession: () => {
      refreshes += 1;
    },
    now: NOW
  });

  assert.equal(resolved.token, "");
  assert.equal(resolved.source, "manual");
  // Refreshing cannot conjure a session that was never created.
  assert.equal(refreshes, 0);
});

test("token expiry is read with skew, and an absent expiry means non-expiring", () => {
  assert.equal(isWranglerTokenUsable({ token: "t", expiresAt: NOW + 600_000 }, NOW), true);
  assert.equal(isWranglerTokenUsable({ token: "t", expiresAt: NOW - 1 }, NOW), false);
  // Inside the skew window it is treated as unusable rather than raced.
  assert.equal(isWranglerTokenUsable({ token: "t", expiresAt: NOW + 30_000 }, NOW), false);
  assert.equal(isWranglerTokenUsable({ token: "t", expiresAt: null }, NOW), true);
  assert.equal(isWranglerTokenUsable({ token: "", expiresAt: null }, NOW), false);
});

test("Wrangler credentials are read without a TOML parser", () => {
  const credentials = parseWranglerCredentials(
    'oauth_token = "abc"\nrefresh_token = "zzz"\nexpiration_time = "2026-08-02T19:00:00.000Z"\n'
  );
  assert.equal(credentials.token, "abc");
  assert.equal(credentials.expiresAt, Date.parse("2026-08-02T19:00:00.000Z"));
  assert.deepEqual(parseWranglerCredentials(""), { token: "", expiresAt: null });
});

test("Wrangler's legacy config directory is preferred over the XDG one", () => {
  // Wrangler itself prefers ~/.wrangler whenever it exists, so probing in a
  // different order could read a stale session.
  const candidates = wranglerConfigCandidates({
    env: {},
    platform: "darwin",
    homedir: "/home"
  });
  assert.deepEqual(candidates, [
    path.join("/home", ".wrangler", "config", "default.toml"),
    path.join("/home", "Library", "Preferences", ".wrangler", "config", "default.toml")
  ]);

  const withHome = wranglerConfigCandidates({
    env: { WRANGLER_HOME: "/custom" },
    platform: "linux",
    homedir: "/home"
  });
  assert.equal(withHome[0], path.join("/custom", "config", "default.toml"));
});

// --- domain shape ----------------------------------------------------------

test("a pasted URL, uppercase, or trailing dot still names a domain", () => {
  assert.equal(normalizeCustomDomainName("HTTPS://Docs.Example.com/reports/"), "docs.example.com");
  assert.equal(normalizeCustomDomainName("docs.example.com."), "docs.example.com");
  assert.equal(normalizeCustomDomainName(" example.com "), "example.com");
});

test("input that is not a domain is rejected rather than normalized into one", () => {
  assert.throws(() => normalizeCustomDomainName(""), /required/i);
  assert.throws(() => normalizeCustomDomainName("localhost"), /not a valid domain/);
  assert.throws(() => normalizeCustomDomainName("docs.example.com:8080"), /port/);
  assert.throws(() => normalizeCustomDomainName("under_score.example.com"), /not a valid domain/);
  // A pages.dev hostname is assigned by Cloudflare; adding it as a custom
  // domain is always a mistake and the error should say why.
  assert.throws(() => normalizeCustomDomainName("alpha.pages.dev"), /assigned by Cloudflare/);
});

test("apex domains are told they must be a Cloudflare zone; subdomains get a CNAME", () => {
  assert.equal(classifyDomain("example.com").kind, "apex");
  assert.equal(classifyDomain("docs.example.com").kind, "subdomain");
  // Multi-label public suffixes would otherwise read as subdomains and get
  // CNAME instructions that cannot work.
  assert.equal(classifyDomain("example.co.uk").kind, "apex");
  assert.equal(classifyDomain("docs.example.co.uk").kind, "subdomain");

  const apex = describeDnsInstructions("example.com", "alpha-reports.pages.dev");
  assert.equal(apex.requiresCloudflareZone, true);
  assert.equal(apex.record, null);
  assert.match(apex.instructions, /nameservers/);

  const sub = describeDnsInstructions("docs.example.com", "https://alpha-reports.pages.dev");
  assert.equal(sub.requiresCloudflareZone, false);
  assert.deepEqual(sub.record, {
    type: "CNAME",
    name: "docs",
    zone: "example.com",
    value: "alpha-reports.pages.dev"
  });
});

// --- origin resolution -----------------------------------------------------

test("links use a custom domain only once Cloudflare reports it active", () => {
  const base = { baseUrl: ASSIGNED_ORIGIN };
  assert.equal(publicBaseUrl(base), ASSIGNED_ORIGIN);
  // A pending domain does not serve traffic yet. Handing out links to it
  // would be worse than handing out the pages.dev ones.
  for (const status of ["initializing", "pending", "deactivated", "blocked", "error"]) {
    assert.equal(
      publicBaseUrl({ ...base, customDomain: { name: "docs.example.com", status } }),
      ASSIGNED_ORIGIN,
      `status ${status} must not take over link generation`
    );
  }
  assert.equal(
    publicBaseUrl({ ...base, customDomain: { name: "docs.example.com", status: "active" } }),
    "https://docs.example.com"
  );
});

test("an unparseable stored domain cannot break link generation", () => {
  assert.equal(
    publicBaseUrl({
      baseUrl: ASSIGNED_ORIGIN,
      customDomain: { name: "not a domain!!", status: "active" }
    }),
    ASSIGNED_ORIGIN
  );
});

test("a custom domain in Cloudflare's domain list cannot hijack the canonical origin", () => {
  // Ownership verification fetches the marker from the canonical origin and
  // the post-deploy correction compares against it, so this must stay the
  // Cloudflare-assigned hostname no matter how the list is ordered.
  assert.equal(
    normalizePagesBaseUrl("docs.example.com, alpha-reports.pages.dev", "alpha-reports"),
    ASSIGNED_ORIGIN
  );
  assert.equal(
    normalizePagesBaseUrl("alpha-reports.pages.dev, docs.example.com", "alpha-reports"),
    ASSIGNED_ORIGIN
  );
  assert.equal(
    normalizePagesBaseUrl("a.example.com b.example.com alpha-reports.pages.dev", "alpha-reports"),
    ASSIGNED_ORIGIN
  );
  // With no assigned hostname in the list at all, the first entry is still
  // better than inventing one.
  assert.equal(
    normalizePagesBaseUrl("docs.example.com", "alpha-reports"),
    "https://docs.example.com"
  );
});

// --- publishing regression -------------------------------------------------

function makeDeployFake() {
  const captures = [];
  return {
    captures,
    fakeDeploy(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {};
      setImmediate(async () => {
        const projectFlag = args.indexOf("--project-name");
        const projectName = projectFlag >= 0 ? args[projectFlag + 1] : "unknown";
        let indexHtml = "";
        try {
          indexHtml = await fs.readFile(
            path.join(options.cwd, "p", "quarterly", "index.html"),
            "utf8"
          );
        } catch {
          indexHtml = "";
        }
        captures.push({ projectName, indexHtml });
        child.stdout.emit(
          "data",
          Buffer.from(`Deployment complete https://${projectName}.pages.dev`)
        );
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    }
  };
}

test("publishing with an active custom domain does not fight the canonical origin", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const sourceDir = path.join(tempDir, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  const reportPath = path.join(sourceDir, "quarterly.html");
  await fs.writeFile(reportPath, "<h1>Quarterly</h1>", "utf8");

  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addPath(reportPath);

  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 2000,
    fetchImpl: async () => new Response("", { status: 404 })
  });

  const pagesConfig = {
    ...TARGET,
    baseUrl: ASSIGNED_ORIGIN,
    adoptExisting: true,
    customDomain: { name: "docs.example.com", status: "active" }
  };

  const url = await publisher.publish({
    report,
    publication: {
      token: "quarterly",
      slug: "quarterly",
      label: "quarterly",
      kind: "snapshot",
      projectRef: { ...TARGET },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null
    },
    pagesConfig
  });

  try {
    assert.equal(url, "https://docs.example.com/p/quarterly/");
    // The whole point of keeping the domain out of baseUrl: exactly one
    // deploy. Storing it there would make the post-deploy correction see a
    // mismatch every time and redeploy to "fix" it.
    assert.equal(captures.length, 1);
    assert.equal(pagesConfig.baseUrl, ASSIGNED_ORIGIN);
    // og:url is baked at publish time and must name the hostname people visit.
    assert.match(captures[0].indexHtml, /property="og:url" content="https:\/\/docs\.example\.com\/p\/quarterly\//);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// --- service ---------------------------------------------------------------

function fakeDomainApi(state = { domains: [] }) {
  return {
    state,
    async listPagesDomains() {
      return state.domains;
    },
    async addPagesDomain({ domain }) {
      const record = { name: domain, status: "pending" };
      state.domains.push(record);
      return record;
    },
    async deletePagesDomain({ domain }) {
      state.domains = state.domains.filter((entry) => entry.name !== domain);
      state.deleted = domain;
      return { name: domain };
    }
  };
}

async function makeServiceContext() {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({ ...TARGET, baseUrl: ASSIGNED_ORIGIN });
  const store = createReportStore({ dataDir });
  await store.init();
  return { tempDir, dataDir, configStore, store };
}

test("adding a domain stores it pending and leaves links on the pages.dev origin", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const result = await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: fakeDomainApi()
    });

    assert.equal(result.customDomain.name, "docs.example.com");
    assert.equal(result.customDomain.status, "pending");
    assert.equal(result.publicBaseUrl, ASSIGNED_ORIGIN);
    assert.equal(result.originChanged, false);
    assert.equal(result.rebased, 0);
    // The operator needs the record before anything can go active.
    assert.equal(result.dns.record.type, "CNAME");
    assert.equal(result.dns.record.value, "alpha-reports.pages.dev");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a domain going active re-hosts existing links and reports stale metadata", async () => {
  const { tempDir, dataDir, configStore, store } = await makeServiceContext();
  try {
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    const reportPath = path.join(sourceDir, "quarterly.html");
    await fs.writeFile(reportPath, "<h1>Quarterly</h1>", "utf8");
    const report = await store.addPath(reportPath);
    const draft = store.draftPublication(report.id, { label: "quarterly" });
    const slug = draft.publication.slug || draft.publication.token;
    await store.commitPublication(report.id, {
      ...draft.publication,
      publicUrl: `${ASSIGNED_ORIGIN}/p/${slug}/`,
      projectRef: { ...TARGET, baseUrl: ASSIGNED_ORIGIN }
    });

    const api = fakeDomainApi();
    await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });

    // Cloudflare finishes DNS validation and issues the certificate.
    api.state.domains = [{ name: "docs.example.com", status: "active" }];
    const result = await getCloudflarePagesDomainWithContext({
      configStore,
      store,
      domainApi: api
    });

    assert.equal(result.customDomain.status, "active");
    assert.equal(result.publicBaseUrl, "https://docs.example.com");
    assert.equal(result.originChanged, true);
    // Without this the feature would be invisible: every adapter reads the
    // publicUrl recorded at publish time.
    assert.equal(result.rebased, 1);
    const [publication] = store.listPublications(configStore.get().pages);
    assert.equal(publication.publicUrl, `https://docs.example.com/p/${slug}/`);
    // The bytes already on Cloudflare still carry the old og:url, and only a
    // re-publish can regenerate them. Say so rather than imply it was fixed.
    assert.equal(result.staleMetadata, 1);

    const reloaded = createConfigStore({ dataDir });
    await reloaded.init();
    assert.equal(reloaded.get().pages.customDomain.status, "active");
    // The canonical origin is untouched by all of this.
    assert.equal(reloaded.get().pages.baseUrl, ASSIGNED_ORIGIN);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a domain deleted at Cloudflare stops being advertised locally", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const api = fakeDomainApi();
    await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });
    api.state.domains = [{ name: "docs.example.com", status: "active" }];
    await getCloudflarePagesDomainWithContext({ configStore, store, domainApi: api });

    // Removed in the Cloudflare dashboard behind Pagecast's back.
    api.state.domains = [];
    const result = await getCloudflarePagesDomainWithContext({
      configStore,
      store,
      domainApi: api
    });

    assert.equal(result.customDomain, null);
    assert.equal(result.removedRemotely, "docs.example.com");
    assert.equal(result.publicBaseUrl, ASSIGNED_ORIGIN);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("removing a domain reverts links even when Cloudflare already dropped it", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const api = fakeDomainApi();
    await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });
    api.state.domains = [{ name: "docs.example.com", status: "active" }];
    await getCloudflarePagesDomainWithContext({ configStore, store, domainApi: api });

    // A 404 from Cloudflare means the desired end state is already true.
    api.deletePagesDomain = async () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    };
    const result = await removeCloudflarePagesDomainWithContext({
      configStore,
      store,
      domainApi: api
    });

    assert.equal(result.removed, "docs.example.com");
    assert.equal(result.customDomain, null);
    assert.equal(result.publicBaseUrl, ASSIGNED_ORIGIN);
    assert.equal(configStore.get().pages.customDomain, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("switching Pages targets drops a domain the new project cannot serve", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const api = fakeDomainApi();
    await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });
    assert.equal(configStore.get().pages.customDomain.name, "docs.example.com");

    await configStore.updatePages({
      accountId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      projectName: "beta-reports"
    });
    assert.equal(configStore.get().pages.customDomain, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("domain operations refuse to run before a Pages target is chosen", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  try {
    const configStore = createConfigStore({ dataDir });
    await configStore.init();
    const store = createReportStore({ dataDir });
    await store.init();

    await assert.rejects(
      addCloudflarePagesDomainWithContext({
        domain: "docs.example.com",
        configStore,
        store,
        domainApi: fakeDomainApi()
      }),
      /pages setup/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// --- transport -------------------------------------------------------------

test("Cloudflare's error message is surfaced, not a bare status code", async () => {
  const api = createCloudflareApi({
    resolveToken: async () => ({ token: "t", source: "api-token" }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 8000000, message: "A domain with this name already exists." }]
        }),
        { status: 409 }
      )
  });

  await assert.rejects(
    api.addPagesDomain({ ...TARGET, domain: "docs.example.com" }),
    (error) => {
      assert.match(error.message, /already exists/);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test("a rejected Wrangler session is explained as a reconnect, not a bad token", async () => {
  const api = createCloudflareApi({
    resolveToken: async () => ({ token: "expired", source: "wrangler-oauth" }),
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), {
        status: 401
      })
  });

  await assert.rejects(api.listPagesDomains(TARGET), /pagecast pages setup/);
});

test("missing credentials are a 401 the caller can offer guided setup for", async () => {
  const api = createCloudflareApi({
    resolveToken: async () => ({ token: "", source: "manual" }),
    fetchImpl: async () => {
      throw new Error("must not be called without credentials");
    }
  });

  await assert.rejects(api.listPagesDomains(TARGET), (error) => {
    assert.equal(error.statusCode, 401);
    assert.match(error.message, /CLOUDFLARE_API_TOKEN/);
    return true;
  });
});

test("domain records are normalized to the fields Pagecast stores", async () => {
  const api = createCloudflareApi({
    resolveToken: async () => ({ token: "t", source: "api-token" }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              name: "Docs.Example.com",
              status: "active",
              certificate_authority: "lets_encrypt",
              validation_data: { status: "active" },
              verification_data: { status: "active" }
            },
            // An unknown status must not silently read as active.
            { name: "other.example.com", status: "something-new" },
            { name: "" }
          ]
        }),
        { status: 200 }
      )
  });

  const domains = await api.listPagesDomains(TARGET);
  assert.equal(domains.length, 2);
  assert.equal(domains[0].name, "docs.example.com");
  assert.equal(domains[0].status, "active");
  assert.equal(domains[0].certificateAuthority, "lets_encrypt");
  assert.equal(domains[1].status, "pending");
});

// --- one domain per target -------------------------------------------------

test("a second domain is refused rather than silently replacing the live one", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    const reportPath = path.join(sourceDir, "quarterly.html");
    await fs.writeFile(reportPath, "<h1>Quarterly</h1>", "utf8");
    const report = await store.addPath(reportPath);
    const draft = store.draftPublication(report.id, { label: "quarterly" });
    const slug = draft.publication.slug || draft.publication.token;
    await store.commitPublication(report.id, {
      ...draft.publication,
      publicUrl: `${ASSIGNED_ORIGIN}/p/${slug}/`,
      projectRef: { ...TARGET, baseUrl: ASSIGNED_ORIGIN }
    });

    const api = fakeDomainApi();
    await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });
    api.state.domains = [{ name: "docs.example.com", status: "active" }];
    await getCloudflarePagesDomainWithContext({ configStore, store, domainApi: api });
    assert.equal(publicBaseUrl(configStore.get().pages), "https://docs.example.com");

    // Storing the second domain would overwrite the first and, because a new
    // domain starts `pending`, knock every live link back to pages.dev. Apex
    // plus www is the common shape of this mistake, so it has to be loud.
    await assert.rejects(
      addCloudflarePagesDomainWithContext({
        domain: "www.example.com",
        configStore,
        store,
        domainApi: api
      }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /already uses docs\.example\.com/);
        return true;
      }
    );

    // Nothing moved: not the tracked domain, not the links, not Cloudflare.
    assert.equal(configStore.get().pages.customDomain.name, "docs.example.com");
    assert.equal(configStore.get().pages.customDomain.status, "active");
    assert.equal(
      store.listPublications(configStore.get().pages)[0].publicUrl,
      `https://docs.example.com/p/${slug}/`
    );
    assert.deepEqual(api.state.domains.map((entry) => entry.name), ["docs.example.com"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("re-adding the tracked domain reconciles it instead of attaching it twice", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const api = fakeDomainApi();
    const first = await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });
    assert.equal(first.adopted, false);

    api.state.domains = [{ name: "docs.example.com", status: "active" }];
    const again = await addCloudflarePagesDomainWithContext({
      // The same domain, typed the way a person might type it the second time.
      domain: "https://Docs.Example.com/",
      configStore,
      store,
      domainApi: api
    });

    assert.equal(again.customDomain.status, "active");
    // Adopted, not re-created: Cloudflare is never asked to attach it twice.
    assert.equal(again.adopted, true);
    assert.equal(api.state.domains.length, 1);
    // A reconcile is not a fresh attachment, so the original timestamp stands.
    assert.equal(again.customDomain.addedAt, first.customDomain.addedAt);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a domain attached at Cloudflare is adopted by name, so `unadopted` is actionable", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    // Attached in Cloudflare's own dashboard, before Pagecast knew about it.
    const api = fakeDomainApi({ domains: [{ name: "docs.example.com", status: "active" }] });

    const status = await getCloudflarePagesDomainWithContext({
      configStore,
      store,
      domainApi: api
    });
    assert.equal(status.customDomain, null);
    assert.deepEqual(status.unadopted, ["docs.example.com"]);

    // Adding the name Cloudflare already knows adopts the record rather than
    // asking Cloudflare to create a domain it already has.
    const adopted = await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.customDomain.status, "active");
    assert.equal(adopted.publicBaseUrl, "https://docs.example.com");
    assert.deepEqual(adopted.unadopted, []);
    assert.equal(api.state.domains.length, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a pending domain reports which Cloudflare check it is still waiting on", async () => {
  const { tempDir, configStore, store } = await makeServiceContext();
  try {
    const api = fakeDomainApi();
    await addCloudflarePagesDomainWithContext({
      domain: "docs.example.com",
      configStore,
      store,
      domainApi: api
    });

    api.state.domains = [
      {
        name: "docs.example.com",
        status: "pending",
        validationStatus: "pending",
        verificationStatus: "inactive",
        certificateAuthority: "google"
      }
    ];
    const result = await getCloudflarePagesDomainWithContext({
      configStore,
      store,
      domainApi: api
    });

    // "pending" alone cannot tell someone whether to go fix DNS or wait for the
    // certificate, which is the whole question when a domain sits for an hour.
    assert.equal(result.progress.validation, "pending");
    assert.equal(result.progress.verification, "inactive");
    assert.equal(result.progress.certificateAuthority, "google");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// --- normalization ---------------------------------------------------------

test("a non-ASCII domain reaches Cloudflare as punycode however it was typed", () => {
  // Both spellings have to resolve to the one record Cloudflare stores;
  // otherwise `add` and `status` disagree about the same domain.
  assert.equal(normalizeCustomDomainName("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeCustomDomainName("https://MÜNCHEN.de/"), "xn--mnchen-3ya.de");
  assert.equal(normalizeCustomDomainName("xn--mnchen-3ya.de"), "xn--mnchen-3ya.de");
});

test("a domain that quietly loses part of what was typed is refused", () => {
  // URL would drop both without a word, and a silently truncated hostname is
  // worse than a rejected one.
  assert.throws(() => normalizeCustomDomainName("docs.example.com:8080"), /must not include a port/);
  assert.throws(() => normalizeCustomDomainName("user:pass@docs.example.com"), /not a valid domain/);
});

test("an aborted response body fails loudly instead of reading as an empty result", async () => {
  const api = createCloudflareApi({
    timeoutMs: 20,
    resolveToken: async () => ({ token: "t", source: "api-token" }),
    fetchImpl: async (_url, init) =>
      new Response(
        new ReadableStream({
          // Headers land immediately and the body never does — the shape a
          // stalled connection actually takes. The stream fails on abort the
          // way undici's does, so the test measures whether the timeout still
          // covers the read rather than whether the fake cooperates.
          start(controller) {
            init.signal.addEventListener("abort", () => {
              controller.error(new Error("This operation was aborted"));
            });
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  });

  await assert.rejects(api.listPagesDomains(TARGET), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /Cloudflare API request failed/);
    return true;
  });
});

// --- the canonical origin, end to end --------------------------------------

test("publishing through the headless path leaves the canonical origin alone", async () => {
  // The service-level test above proves publishPublications does not fight the
  // canonical origin. It cannot see the layer above: publish returns the public
  // URL, callers store it as publicUrl, and persistActualPublicationOrigin then
  // reads that back as evidence of what Cloudflare assigned. With an active
  // custom domain that evidence is the domain, so the first publish wrote it
  // into pages.baseUrl -- the one field the whole design keeps it out of.
  const accountId = "abcdef0123456789abcdef0123456789";
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportPath = path.join(tempDir, "quarterly.html");
  await fs.writeFile(reportPath, "<h1>Quarterly</h1>", "utf8");

  function wranglerFake(args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      let output = "";
      if (args.includes("whoami")) {
        output = JSON.stringify({ accounts: [{ name: "Personal", id: accountId }] });
      } else if (args.includes("list")) {
        output = JSON.stringify([{ name: "pagecast", account_id: accountId }]);
      }
      if (output) child.stdout.emit("data", Buffer.from(output));
      child.emit("exit", 0, null);
    });
    return child;
  }
  function deployFake() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("deploy complete"));
      child.emit("exit", 0, null);
    });
    return child;
  }

  try {
    const configStore = createConfigStore({ dataDir });
    await configStore.init();
    await configStore.updatePages({
      projectName: "pagecast",
      accountId,
      baseUrl: "https://pagecast.pages.dev",
      adoptExisting: true
    });
    await configStore.setCustomDomain({
      name: "docs.example.com",
      status: "active",
      addedAt: "2026-08-02T18:00:00.000Z"
    });

    const result = await publishReportSnapshot({
      path: reportPath,
      dataDir,
      cloudflareAuthSpawnImpl: (_command, args) => wranglerFake(args),
      pagesDeploySpawnImpl: deployFake,
      cloudflareListTimeoutMs: 1000,
      pagesDeployTimeoutMs: 1000
    });

    // The link people get is the domain's.
    assert.match(result.url, /^https:\/\/docs\.example\.com\/p\/.+\/$/);

    const reloaded = createConfigStore({ dataDir });
    await reloaded.init();
    // The origin Cloudflare assigned is untouched, so ownership verification
    // still fetches the marker from it and the DNS guidance still names it as
    // the CNAME target rather than pointing the domain at itself.
    assert.equal(reloaded.get().pages.baseUrl, "https://pagecast.pages.dev");
    assert.equal(reloaded.get().pages.customDomain.name, "docs.example.com");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
