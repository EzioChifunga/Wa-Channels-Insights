const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
const manifestName = chrome.runtime.getManifest().name;
document.getElementById("title").textContent = manifestName.startsWith("__MSG_") ? t("extName") : manifestName;

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return t("justNow");
  if (min < 60) return t("minutesAgo", String(min));
  return new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function paint(id, cls) {
  document.getElementById(id).className = `dot ${cls}`;
}

function showFailure(error) {
  document.getElementById("run").textContent = t("notCollected");
  document.getElementById("run-sub").textContent = error || "";
  paint("dot-run", "error");
}

async function show() {
  const { destination, lastRun } = await chrome.runtime.sendMessage({ type: "status" });

  document.getElementById("destination").textContent = destination.text;
  paint("dot-destination", destination.ok ? "ok" : "error");

  const run = document.getElementById("run");
  const sub = document.getElementById("run-sub");
  if (!lastRun) {
    run.textContent = t("noRunYet");
    sub.textContent = "";
    paint("dot-run", "neutral");
  } else if (lastRun.ok) {
    run.textContent = t("runOk", ago(lastRun.at));
    sub.textContent =
      t("runCounts", [String(lastRun.channels), String(lastRun.posts ?? 0)]) + (lastRun.summary ? ` · ${lastRun.summary}` : "");
    paint("dot-run", "ok");
  } else {
    run.textContent = t("runFailed", ago(lastRun.at));
    sub.textContent = lastRun.error || "";
    paint("dot-run", "error");
  }
}

/** Disables the button with a "working" label; the returned function puts it back. */
function busy(button, label) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return (done) => {
    button.disabled = false;
    button.textContent = done ?? original;
    if (done) setTimeout(() => (button.textContent = original), 2500);
  };
}

document.getElementById("collect").addEventListener("click", async (e) => {
  const restore = busy(e.target, t("collecting"));
  const r = await chrome.runtime.sendMessage({ type: "collect-now" });
  restore();
  if (r && !r.ok) return showFailure(r.error);
  show();
});

document.getElementById("export").addEventListener("click", async (e) => {
  const restore = busy(e.target, t("collecting"));
  const r = await chrome.runtime.sendMessage({ type: "export" });
  if (!r?.ok) {
    restore();
    return showFailure(r?.error);
  }
  const blob = new Blob([JSON.stringify(r.payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wa-channels-${r.payload.collected_at.replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  restore(t("exported"));
});

document.getElementById("diagnostics").addEventListener("click", async (e) => {
  const restore = busy(e.target, t("readingWhatsApp"));
  const now = await chrome.runtime.sendMessage({ type: "diagnostics-now" }).catch((error) => ({ error: String(error) }));
  const { diagnostics, lastRun } = await chrome.storage.local.get(["diagnostics", "lastRun"]);
  await navigator.clipboard.writeText(
    JSON.stringify({ now, lastRun: lastRun ?? null, samplesFromLastRun: diagnostics ?? null }, null, 1),
  );
  restore(now?.error ? t("copiedWithError") : t("copied"));
});

document.getElementById("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

show();
