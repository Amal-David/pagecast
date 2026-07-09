import assert from "node:assert/strict";
import test from "node:test";

import { createPublicToken, publicTokenNamePrefix } from "../src/server.js";

const HEX_TAIL = /-[0-9a-f]{32}$/;

test("createPublicToken combines a memorable prefix with a 128-bit capability", () => {
  for (let i = 0; i < 500; i += 1) {
    const token = createPublicToken();
    assert.match(token, HEX_TAIL, `"${token}" is missing its capability`);
    const prefix = publicTokenNamePrefix(token);
    const parts = prefix.split("-");
    assert.ok(parts.length >= 2, `"${prefix}" should be at least two words`);
    for (const part of parts) {
      assert.match(part, /^[a-z]+$/, `part "${part}" is not pure lowercase letters`);
    }
    assert.ok(token.length <= 63);
  }
});

test("createPublicToken re-rolls until the name is not taken", () => {
  // isNameTaken reports the first 5 candidates as taken; createPublicToken must
  // keep generating, so it is called at least 6 times before returning.
  let calls = 0;
  const token = createPublicToken(() => {
    calls += 1;
    return calls <= 5;
  });
  assert.ok(calls >= 6, `expected re-rolls, isNameTaken called ${calls} times`);
  assert.match(token, /^[a-z]+(?:-[a-z]+)+-[0-9a-f]{32}$/);
});

test("publicTokenNamePrefix strips a legacy entropy tail but leaves clean names alone", () => {
  const hex = "a".repeat(32);
  // Legacy "<name>-<32hex>" tokens reduce to their name.
  assert.equal(publicTokenNamePrefix(`v1-${hex}`), "v1");
  assert.equal(publicTokenNamePrefix(`quietly-fading-casket-${hex}`), "quietly-fading-casket");
  // New tail-free names are returned unchanged.
  assert.equal(publicTokenNamePrefix("hollow-paperclip"), "hollow-paperclip");
  assert.equal(publicTokenNamePrefix("nostalgic-curie"), "nostalgic-curie");
  assert.equal(publicTokenNamePrefix(""), "");
});

test("a fresh token exposes its memorable prefix without its capability", () => {
  const token = createPublicToken();
  assert.notEqual(publicTokenNamePrefix(token), token);
  assert.match(publicTokenNamePrefix(token), /^[a-z]+(?:-[a-z]+)+$/);
});

test("a drop stays short while the default gets an unlisted capability", () => {
  for (let i = 0; i < 200; i += 1) {
    const dropParts = createPublicToken(() => false, { drop: true }).split("-");
    assert.ok(dropParts.length <= 3, `drop name should be short, got ${dropParts.length} words`);

    assert.match(createPublicToken(() => false, { drop: false }), HEX_TAIL);
  }
});

test("unlisted (non-drop) is the default when no option is passed", () => {
  assert.match(createPublicToken(), HEX_TAIL);
});
