// No integration built in: collections go to the webhook set on the options
// page. To plug in your own delivery, authentication or extra content scripts,
// build with `node scripts/build.mjs --integration <dir>` — see
// docs/INTEGRATIONS.md. This file is replaced by <dir>/integration.js.
globalThis.WCI_INTEGRATION = null;
