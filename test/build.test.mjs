import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { build, mergeManifest } from "../scripts/build.mjs";

test("mergeManifest appends arrays, merges objects and replaces the rest", () => {
  const merged = mergeManifest(
    { name: "a", host_permissions: ["x"], action: { default_popup: "p.html", default_title: "a" } },
    { name: "b", host_permissions: ["x", "y"], action: { default_title: "b" } },
  );
  assert.deepEqual(merged, { name: "b", host_permissions: ["x", "y"], action: { default_popup: "p.html", default_title: "b" } });
});

test("build without integration keeps the empty default", () => {
  const out = join(mkdtempSync(join(tmpdir(), "wci-")), "dist");
  const { manifest } = build({ out });
  assert.equal(manifest.name, "__MSG_extName__");
  assert.match(readFileSync(join(out, "integration/integration.js"), "utf8"), /WCI_INTEGRATION = null/);
  assert.ok(existsSync(join(out, "_locales/en/messages.json")));
});

test("build with an integration copies it and merges its manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "wci-"));
  const integration = join(root, "acme");
  mkdirSync(integration);
  writeFileSync(join(integration, "integration.js"), "globalThis.WCI_INTEGRATION = { id: 'acme' };");
  writeFileSync(join(integration, "login.js"), "// content script");
  writeFileSync(
    join(integration, "manifest.override.json"),
    JSON.stringify({
      name: "Acme Channels",
      host_permissions: ["https://acme.test/*"],
      content_scripts: [{ matches: ["https://acme.test/*"], js: ["integration/login.js"] }],
    }),
  );
  const out = join(root, "dist");
  const { manifest } = build({ integration, out });
  assert.equal(manifest.name, "Acme Channels");
  assert.deepEqual(manifest.host_permissions, ["https://web.whatsapp.com/*", "https://acme.test/*"]);
  assert.equal(manifest.content_scripts.length, 3);
  assert.match(readFileSync(join(out, "integration/integration.js"), "utf8"), /acme/);
  assert.ok(existsSync(join(out, "integration/login.js")));
  assert.ok(!existsSync(join(out, "integration/manifest.override.json")));
});

test("build refuses an output inside the sources", () => {
  assert.throws(() => build({ out: new URL("../extension/dist", import.meta.url).pathname.replace(/^\/(\w:)/, "$1") }));
});
