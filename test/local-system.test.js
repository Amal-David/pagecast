import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTS_BEGIN,
  HOSTS_END,
  PF_ANCHOR_NAME,
  PORTLESS_LOCAL_HOST,
  PORTLESS_LOOPBACK_IP,
  backgroundLaunchAgentLabel,
  buildBackgroundLaunchAgentPlist,
  buildLocalUrlInstallScript,
  buildLocalUrlRemoveScript,
  buildPfRules
} from "../src/local-system.js";

test("pf rules redirect only the Pagecast loopback alias to the configured admin port", () => {
  const rules = buildPfRules({ targetPort: 4173 });
  assert.match(rules, new RegExp(`to ${PORTLESS_LOOPBACK_IP} port 80`));
  assert.match(rules, /-> 127\.0\.0\.1 port 4173/);
  assert.doesNotMatch(rules, /to 127\.0\.0\.1 port 80/);
});

test("local-url install script writes hosts, pf rules, and a launch daemon", () => {
  const script = buildLocalUrlInstallScript({ targetPort: 4321 });
  assert.match(script, new RegExp(`${PORTLESS_LOOPBACK_IP} ${PORTLESS_LOCAL_HOST}`));
  assert.match(script, new RegExp(HOSTS_BEGIN));
  assert.match(script, new RegExp(HOSTS_END));
  assert.match(script, new RegExp(`/sbin/pfctl -a '${PF_ANCHOR_NAME}' -f`));
  assert.match(script, /127\.0\.0\.1 port 4321/);
  assert.match(script, /launchctl bootstrap system/);
});

test("local-url remove script unloads only Pagecast-owned local URL state", () => {
  const script = buildLocalUrlRemoveScript();
  assert.match(script, new RegExp(`/sbin/pfctl -a '${PF_ANCHOR_NAME}' -F all`));
  assert.match(script, new RegExp(`ifconfig lo0 -alias '${PORTLESS_LOOPBACK_IP}'`));
  assert.match(script, new RegExp(HOSTS_BEGIN));
  assert.match(script, /launchctl bootout system/);
});

test("background launch agent plist escapes paths and runs pagecast serve", () => {
  const label = backgroundLaunchAgentLabel("/Users/amal/Pagecast Workspace");
  const plist = buildBackgroundLaunchAgentPlist({
    label,
    nodePath: "/usr/local/bin/node",
    cliPath: "/tmp/pagecast's/src/cli.js",
    workingDirectory: "/tmp/Pagecast & Reports",
    stdoutPath: "/tmp/Pagecast & Reports/.pagecast/out.log",
    stderrPath: "/tmp/Pagecast & Reports/.pagecast/err.log",
    pathEnv: "/opt/homebrew/bin:/usr/bin"
  });

  assert.match(label, /^com\.pagecast\.background\.[a-f0-9]{12}$/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<string>--no-open<\/string>/);
  assert.match(plist, /pagecast&apos;s/);
  assert.match(plist, /Pagecast &amp; Reports/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
});
