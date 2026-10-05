// Delivers what collector.js reads from WhatsApp Web. The fetch happens here
// (not in the WhatsApp tab) because the extension holds the host permission
// for the destination; from the tab, the browser would block it.
//
// Where it goes: an integration (integration/integration.js, see
// docs/INTEGRATIONS.md) when one is built in, otherwise the webhook set on the
// options page.
importScripts("lib/core.js", "integration/integration.js");

const integration = globalThis.WCI_INTEGRATION || null;
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

async function settings() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings || {};
}

async function deliverToWebhook(payload) {
  const { webhookUrl, authorization } = await settings();
  if (!webhookUrl) return { ok: false, error: t("errNoDestination") };
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = typeof body?.error === "string" ? body.error : t("errHttp", String(response.status));
      return { ok: false, error: detail };
    }
    return {
      ok: true,
      response: body,
      knownStickerHashes: Array.isArray(body?.known_sticker_hashes) ? body.known_sticker_hashes : [],
      summary: typeof body?.summary === "string" ? body.summary : null,
    };
  } catch (e) {
    return { ok: false, error: t("errNetwork", e.message) };
  }
}

async function deliver(payload, reason) {
  try {
    if (integration?.deliver) return await integration.deliver(payload, { reason });
    return await deliverToWebhook(payload);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function destinationStatus() {
  if (integration?.status) return integration.status();
  const { webhookUrl } = await settings();
  if (!webhookUrl) return { ok: false, text: t("statusNoDestination") };
  return { ok: true, text: t("statusWebhook", new URL(webhookUrl).host) };
}

/** Sends a message to the open WhatsApp Web tab's collector. */
async function askWhatsAppTab(message) {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  if (!tabs.length) return { ok: false, error: t("errNoWhatsAppTab") };
  try {
    return await chrome.tabs.sendMessage(tabs[0].id, message);
  } catch {
    return { ok: false, error: t("errReloadTab") };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // the integration sees every message first; `undefined` means "not mine"
  if (integration?.onMessage) {
    const handled = integration.onMessage(msg, sender, respond);
    if (handled !== undefined) return handled;
  }
  if (msg.type === "deliver") {
    deliver(msg.payload, msg.reason).then(async (result) => {
      await chrome.storage.local.set({
        lastRun: {
          at: Date.now(),
          reason: msg.reason,
          channels: msg.payload.channels.length,
          posts: WCI.countPosts(msg.payload.channels),
          ok: !!result?.ok,
          error: result?.ok ? null : result?.error || null,
          summary: result?.summary || null,
        },
        ...(msg.diagnostics ? { diagnostics: msg.diagnostics } : {}),
      });
      respond(result);
    });
    return true;
  }
  if (msg.type === "status") {
    Promise.all([destinationStatus(), chrome.storage.local.get("lastRun")]).then(([destination, { lastRun }]) =>
      respond({ destination, lastRun: lastRun || null, integration: integration?.id || null }),
    );
    return true;
  }
  if (msg.type === "collect-now") {
    askWhatsAppTab({ type: "collect" }).then(respond);
    return true;
  }
  if (msg.type === "export") {
    askWhatsAppTab({ type: "collect", deliver: false }).then(respond);
    return true;
  }
  if (msg.type === "diagnostics-now") {
    askWhatsAppTab({ type: "diagnostics" }).then((r) => respond(r?.ok === false ? { error: r.error } : r));
    return true;
  }
  return false;
});
