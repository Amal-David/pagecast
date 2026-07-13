import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

for (const path of [
  ".codex/skills/publish-report/SKILL.md",
  "plugin/skills/publish-report/SKILL.md"
]) {
  test(`${path} executes explicit Pagecast requests with context-aware results`, () => {
    const skill = readFileSync(new URL(path, root), "utf8");
    assert.match(skill, /sufficient\s+consent/i);
    assert.match(skill, /Run the publish command immediately/i);
    assert.match(skill, /proactive suggestion still asks once/i);
    assert.match(skill, /asks only for the command[\s\S]*do not run it/i);
    assert.match(skill, /--new-link/);
    assert.match(skill, /--update/);
    assert.match(skill, /"action": "created" \| "updated"/);
    assert.match(skill, /resumes automatically/i);
    assert.match(skill, /Never ask the user to provide a page password in chat/i);
    assert.doesNotMatch(skill, /--(?:no-)?password\b/i);
    assert.doesNotMatch(skill, /["'](?:password|passwordProtected)["']\s*:/i);
    assert.doesNotMatch(skill, /hunter2/i);
    assert.doesNotMatch(skill, /re-running `publish` (?:mints|creates) a new link/i);
  });
}
