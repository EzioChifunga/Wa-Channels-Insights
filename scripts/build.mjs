#!/usr/bin/env node
// Builds a loadable extension folder: the core in extension/ plus, optionally,
// an integration (your own delivery, authentication, content scripts).
//
//   node scripts/build.mjs                                  → dist/
//   node scripts/build.mjs --integration ../my-integration  → dist/ with it built in
//   node scripts/build.mjs --integration <dir> --out <dir>
//
// The integration folder is copied to <out>/integration/ (its integration.js
// replaces the empty default) and its manifest.override.json, if any, is
// merged into the manifest. See docs/INTEGRATIONS.md.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERRIDE = "manifest.override.json";

/**
 * Merges the integration's manifest fragment: objects merge key by key, arrays
 * are appended (without repeating what's there) and anything else is replaced.
 */
export function mergeManifest(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      const seen = new Set(current.map((v) => JSON.stringify(v)));
      out[key] = [...current, ...value.filter((v) => !seen.has(JSON.stringify(v)))];
    } else if (isObject(current) && isObject(value)) {
      out[key] = mergeManifest(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function build({ integration = null, out = join(ROOT, "dist") } = {}) {
  out = resolve(out);
  const source = join(ROOT, "extension");
  if (out === source || out.startsWith(source + sep)) throw new Error("--out can't be inside extension/");
  rmSync(out, { recursive: true, force: true });
  cpSync(source, out, { recursive: true });

  let manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  if (integration) {
    integration = resolve(integration);
    if (!existsSync(join(integration, "integration.js"))) throw new Error(`${integration} has no integration.js`);
    if (out.startsWith(integration + sep)) throw new Error("--out can't be inside the integration folder");
    cpSync(integration, join(out, "integration"), {
      recursive: true,
      // the override is build input, not part of the extension
      filter: (path) => !path.endsWith(sep + OVERRIDE) && !/[\\/](\.[^\\/]+|node_modules)$/.test(path),
    });
    const overridePath = join(integration, OVERRIDE);
    if (existsSync(overridePath)) manifest = mergeManifest(manifest, JSON.parse(readFileSync(overridePath, "utf8")));
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { out, manifest };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--integration") args.integration = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, manifest } = build(parseArgs(process.argv.slice(2)));
    console.log(`Built ${manifest.short_name || manifest.name} ${manifest.version} → ${out}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
