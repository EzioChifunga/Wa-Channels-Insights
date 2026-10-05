# Integrations

The webhook on the options page covers most uses: every collection is POSTed as
JSON to your URL, with an optional `Authorization` header. When you need more —
your own login flow, a different body format, talking to an app the user
already has open — build the extension with an **integration**.

An integration is a folder:

```
my-integration/
  integration.js            required — runs in the background service worker
  manifest.override.json    optional — merged into the extension manifest
  anything-else.js          optional — e.g. content scripts for your own site
```

Build it in:

```sh
node scripts/build.mjs --integration ../my-integration --out ../my-integration-dist
```

The folder is copied to `<out>/integration/`, so files are referenced from the
manifest as `integration/<file>`. Load `<out>` as an unpacked extension.

## `integration.js`

A classic script (loaded with `importScripts`) that sets
`globalThis.WCI_INTEGRATION`. Every member is optional; whatever you leave out
falls back to the default behaviour.

```js
globalThis.WCI_INTEGRATION = {
  // shown on the options page
  id: "acme",

  // Replaces the webhook. Receives the payload described in the README.
  async deliver(payload, { reason }) {
    const res = await fetch("https://acme.example/api/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
      body: JSON.stringify(toAcmeFormat(payload)),
    });
    if (!res.ok) return { ok: false, error: `Acme answered ${res.status}` };
    const body = await res.json();
    return {
      ok: true,
      // sticker hashes whose image you already stored: the collector stops sending those files
      knownStickerHashes: body.stored_stickers,
      // short text shown in the popup after the counts
      summary: `${body.new_posts} new`,
    };
  },

  // The "destination" line of the popup: {ok, text}.
  async status() {
    return (await getToken()) ? { ok: true, text: "Signed in to Acme" } : { ok: false, text: "Sign in to Acme" };
  },

  // Sees every runtime message before the core does. Return undefined to let
  // the core handle it, false when you handled it synchronously, true when you
  // will call `respond` later.
  onMessage(msg, sender, respond) {
    if (msg.type === "acme-token") {
      chrome.storage.local.set({ acmeToken: msg.token });
      return false;
    }
    return undefined;
  },
};
```

`reason` is one of `startup`, `check` (something changed since the last
delivery), `interval` (every 15 minutes regardless), `insights` (the insights
screen was opened) or `manual` ("Collect now").

Keep your own state in `chrome.storage.local` under keys of your own; the core
uses `settings`, `lastRun` and `diagnostics`.

## `manifest.override.json`

Merged into `manifest.json`: objects merge key by key, arrays are appended and
anything else is replaced. Typical use: a name, host permissions for your API
and a content script on your own site.

```json
{
  "name": "Acme · WhatsApp Channels",
  "host_permissions": ["https://acme.example/*"],
  "content_scripts": [
    { "matches": ["https://acme.example/*"], "js": ["integration/acme-login.js"], "run_at": "document_idle" }
  ]
}
```

## Example: reuse the login of your web app

If your users are already signed in to your web app, a content script on it can
hand the session to the extension, so they never configure anything:

```js
// integration/acme-login.js — runs on https://acme.example/*
const token = localStorage.getItem("acme_token");
if (token) chrome.runtime.sendMessage({ type: "acme-token", token });
```

The background integration stores it (see `onMessage` above) and uses it in
`deliver`. Sending through your app's own origin (e.g. a `/api` proxy on the
same domain) also avoids configuring CORS on your API.

## Testing an integration

`testing/harness.mjs` runs the content scripts against a fake WhatsApp Web tab
(`testing/fixture.mjs`) in Node, so you can test your payload mapping without a
browser or a WhatsApp account:

```js
import { createTab } from "<path to this repo>/testing/harness.mjs";
import { fixture } from "<path to this repo>/testing/fixture.mjs";

const tab = createTab(fixture());
for (const f of ["lib/core.js", "content/collector.js", "content/page.js"]) tab.load(`<path to this repo>/extension/${f}`);
const { payload } = await tab.message({ type: "collect", deliver: false });
```
