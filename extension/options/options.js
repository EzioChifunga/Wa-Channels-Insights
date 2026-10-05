const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);

const url = document.getElementById("webhookUrl");
const authorization = document.getElementById("authorization");
const message = document.getElementById("message");

chrome.storage.local.get("settings").then(({ settings }) => {
  url.value = settings?.webhookUrl || "";
  authorization.value = settings?.authorization || "";
});

chrome.runtime.sendMessage({ type: "status" }).then(({ integration }) => {
  if (!integration) return;
  const notice = document.getElementById("integration");
  notice.textContent = t("integrationActive", integration);
  notice.hidden = false;
});

function allowed(u) {
  return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
}

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";
  const value = url.value.trim();
  if (value) {
    let parsed = null;
    try {
      parsed = new URL(value);
    } catch {
      // stays null
    }
    if (!parsed || !allowed(parsed)) {
      message.textContent = t("invalidUrl");
      return;
    }
    // asked here, on the click: Chrome only shows the prompt during a user gesture
    const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
    if (!granted) {
      message.textContent = t("permissionDenied");
      return;
    }
  }
  await chrome.storage.local.set({ settings: { webhookUrl: value, authorization: authorization.value.trim() } });
  message.textContent = t("saved");
});
