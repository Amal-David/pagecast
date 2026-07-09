import assert from "node:assert/strict";
import test from "node:test";

import {
  PAGECAST_PROJECT_MARKER_FILE,
  encodeProjectOwnershipMarker,
  normalizeProjectRef,
  normalizeStoredProjectRef,
  parseOwnershipMarker,
  projectRefEquals,
  projectRefFilesystemKey,
  validateOwnershipMarker
} from "../src/project-ref.js";

const ACCOUNT_A = "AABBCCDDEEFF00112233445566778899";
const ACCOUNT_B = "00112233445566778899AABBCCDDEEFF";

test("ProjectRef canonicalizes explicit identity while keeping baseUrl as metadata", () => {
  assert.deepEqual(
    normalizeProjectRef({
      accountId: `  ${ACCOUNT_A}  `,
      projectName: "  My-Reports  ",
      baseUrl: "MY-REPORTS-6CV.PAGES.DEV/some/ignored/path/"
    }),
    {
      accountId: ACCOUNT_A.toLowerCase(),
      projectName: "my-reports",
      baseUrl: "https://my-reports-6cv.pages.dev"
    }
  );
});

test("ProjectRef requires both canonical identity fields", () => {
  assert.throws(
    () => normalizeProjectRef({ projectName: "my-reports" }),
    /account ID must be 32 hex characters/i
  );
  assert.throws(
    () => normalizeProjectRef({ accountId: ACCOUNT_A }),
    /project name must be a valid lowercase slug/i
  );
  assert.throws(
    () => normalizeProjectRef({ accountId: "not-an-account", projectName: "my-reports" }),
    /account ID must be 32 hex characters/i
  );
  assert.throws(
    () => normalizeProjectRef({ accountId: ACCOUNT_A, projectName: "bad/name" }),
    /project name must be a valid lowercase slug/i
  );
});

test("ProjectRef equality and filesystem identity ignore mutable baseUrl metadata", () => {
  const first = {
    accountId: ACCOUNT_A,
    projectName: "my-reports",
    baseUrl: "https://my-reports.pages.dev"
  };
  const renamedOrigin = {
    accountId: ACCOUNT_A.toLowerCase(),
    projectName: "MY-REPORTS",
    baseUrl: "https://reports.example.com"
  };

  assert.equal(projectRefEquals(first, renamedOrigin), true);
  assert.equal(projectRefFilesystemKey(first), projectRefFilesystemKey(renamedOrigin));
  assert.equal(projectRefEquals(first, { ...first, accountId: ACCOUNT_B }), false);
  assert.equal(projectRefEquals(first, { ...first, projectName: "other-reports" }), false);
});

test("ProjectRef filesystem keys are deterministic, collision-resistant identity keys", () => {
  const first = projectRefFilesystemKey({
    accountId: ACCOUNT_A,
    projectName: "my-reports"
  });
  const repeat = projectRefFilesystemKey({
    accountId: ACCOUNT_A.toLowerCase(),
    projectName: "MY-REPORTS"
  });
  const otherAccount = projectRefFilesystemKey({
    accountId: ACCOUNT_B,
    projectName: "my-reports"
  });

  assert.equal(first, repeat);
  assert.notEqual(first, otherAccount);
  assert.match(first, /^[a-f0-9]{32}--[a-z0-9-]{1,63}$/);
  assert.doesNotMatch(first, /[./\\]/);
});

test("stored canonical ProjectRef data is normalized without consulting URLs", () => {
  assert.deepEqual(
    normalizeStoredProjectRef({
      projectRef: {
        accountId: ACCOUNT_A,
        projectName: "My-Reports"
      },
      baseUrl: "https://reports.example.com/path",
      publicUrl: "https://another-project.pages.dev/p/example/"
    }),
    {
      accountId: ACCOUNT_A.toLowerCase(),
      projectName: "my-reports",
      baseUrl: "https://reports.example.com"
    }
  );
});

test("stored legacy targets require an explicit opt-in and complete identity", () => {
  const legacy = {
    pagesAccountId: ACCOUNT_A,
    pagesProjectName: "My-Reports",
    pagesBaseUrl: "https://my-reports-6cv.pages.dev"
  };

  assert.equal(normalizeStoredProjectRef(legacy), null);
  assert.deepEqual(normalizeStoredProjectRef(legacy, { allowLegacy: true }), {
    accountId: ACCOUNT_A.toLowerCase(),
    projectName: "my-reports",
    baseUrl: "https://my-reports-6cv.pages.dev"
  });
  assert.equal(
    normalizeStoredProjectRef(
      { pagesProjectName: "my-reports", pagesBaseUrl: "https://my-reports.pages.dev" },
      { allowLegacy: true }
    ),
    null
  );
});

test("a pages.dev hostname is never inferred as project identity", () => {
  const assignedCollisionHost = {
    publicUrl: "https://pagecast-6cv.pages.dev/p/example/",
    baseUrl: "https://pagecast-6cv.pages.dev"
  };

  assert.equal(normalizeStoredProjectRef(assignedCollisionHost), null);
  assert.equal(normalizeStoredProjectRef(assignedCollisionHost, { allowLegacy: true }), null);
});

test("ownership markers round-trip the persistent owner, mode, and canonical ProjectRef", () => {
  const projectRef = {
    accountId: ACCOUNT_A,
    projectName: "My-Reports",
    baseUrl: "MY-REPORTS-6CV.PAGES.DEV/a/path"
  };
  const ownership = {
    ownerId: "  owner-8d21f3  ",
    mode: "publications",
    projectRef
  };
  const marker = encodeProjectOwnershipMarker(ownership);
  const parsedJson = JSON.parse(marker);

  assert.equal(PAGECAST_PROJECT_MARKER_FILE, "__pagecast/ownership.json");
  assert.equal(marker.endsWith("\n"), true);
  assert.deepEqual(parsedJson, {
    format: "pagecast-project-owner",
    version: 1,
    ownerId: "owner-8d21f3",
    mode: "publications",
    accountId: ACCOUNT_A.toLowerCase(),
    projectName: "my-reports",
    baseUrl: "https://my-reports-6cv.pages.dev"
  });
  assert.deepEqual(parseOwnershipMarker(marker), {
    ownerId: "owner-8d21f3",
    mode: "publications",
    projectRef: {
      accountId: ACCOUNT_A.toLowerCase(),
      projectName: "my-reports",
      baseUrl: "https://my-reports-6cv.pages.dev"
    }
  });
  assert.deepEqual(
    parseOwnershipMarker(
      encodeProjectOwnershipMarker({
        ownerId: "owner-8d21f3",
        mode: "publications",
        ...projectRef
      })
    ),
    parseOwnershipMarker(marker),
    "the publisher's existing flat Pages config shape must remain supported"
  );
});

test("ownership validation requires the expected owner, project identity, and mode", () => {
  const expected = {
    ownerId: "owner-8d21f3",
    mode: "direct",
    projectRef: {
      accountId: ACCOUNT_A,
      projectName: "my-reports",
      baseUrl: "https://my-reports.pages.dev"
    }
  };
  const marker = encodeProjectOwnershipMarker(expected);

  assert.equal(
    validateOwnershipMarker(marker, {
      ...expected,
      projectRef: { ...expected.projectRef, baseUrl: "https://reports.example.com" }
    }),
    true
  );
  assert.equal(validateOwnershipMarker(marker, { ...expected, ownerId: "another-owner" }), false);
  assert.equal(validateOwnershipMarker(marker, { ...expected, mode: "publications" }), false);
  assert.equal(
    validateOwnershipMarker(marker, {
      ...expected,
      projectRef: { ...expected.projectRef, accountId: ACCOUNT_B }
    }),
    false
  );
  assert.equal(validateOwnershipMarker("not-json", expected), false);
});

test("ownership markers reject empty owners and unsupported modes", () => {
  const projectRef = { accountId: ACCOUNT_A, projectName: "my-reports" };

  assert.throws(
    () => encodeProjectOwnershipMarker({ ownerId: "  ", mode: "publications", projectRef }),
    /owner ID must be non-empty/i
  );
  assert.throws(
    () => encodeProjectOwnershipMarker({ ownerId: "owner-1", mode: "preview", projectRef }),
    /mode must be publications or direct/i
  );
});
