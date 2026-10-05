// Runs in the WhatsApp Web tab and only READS what is already in the browser:
//
// - channel posts, which page.js reads from the page's memory (text, type,
//   views, forwards, polls with votes, stickers) — only the ones WhatsApp Web
//   has loaded: opening a channel loads the recent ones;
// - emoji reactions per post (IndexedDB `newsletter-reactions`) and poll/quiz
//   tallies (`newsletter-polls-votes`) — both keep the counts in a Map;
// - WhatsApp Web's local database (IndexedDB `model-storage`): name,
//   description, invite code, creation date, followers (`size`) and picture
//   of each channel. Only channels this account administers
//   (`membershipType` 1); the ones it just follows are left out;
// - the "Channel insights" screen, when it is open: the last 30 days'
//   insights (accounts reached, net followers), which WhatsApp doesn't keep in
//   the local database.
//
// It doesn't click anything, send messages or ask WhatsApp for anything: it's
// like someone looking at the screen. Delivery happens in the background
// worker.
(() => {
  const { SCHEMA, toCount, entriesOf, parentKey, parseDisplayedNumber, parsePeriodDays, signatureOf } = globalThis.WCI;

  const ADMIN = 1;
  // every 2 minutes, check whether something changed (new post, reaction,
  // view) and deliver only if it did; every 15, deliver regardless
  const CHECK_MS = 2 * 60_000;
  const INTERVAL_MS = 15 * 60_000;
  const MAX_POSTS = 300;
  const CHANNEL = "wa-channels-insights";

  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  function openDb() {
    return new Promise((ok, fail) => {
      // no version: open whatever exists; never trigger an upgrade on WhatsApp's database
      const request = indexedDB.open("model-storage");
      request.onsuccess = () => ok(request.result);
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = () => {
        request.transaction.abort();
        fail(new Error(t("errNotLoaded")));
      };
    });
  }

  function readAll(db, store) {
    return new Promise((ok) => {
      if (!db.objectStoreNames.contains(store)) return ok([]);
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => ok(request.result || []);
      request.onerror = () => ok([]);
    });
  }

  function read(db, store, key) {
    return new Promise((ok) => {
      if (!db.objectStoreNames.contains(store)) return ok(null);
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => ok(request.result || null);
      request.onerror = () => ok(null);
    });
  }

  function pageLocale() {
    return document.documentElement.lang || navigator.language || "en";
  }

  /** Insights from the "Channel insights" screen, if it is open. */
  function insightsFromScreen(channels) {
    const section = document.querySelector('[data-testid="channel-admin-insights-insights-section"]');
    if (!section) return null;

    // the channel name is the line above "Channel · N followers"
    const subtitle = document.querySelector('[data-testid="newsletter-info-top-card-subtitle"]');
    const name = subtitle?.parentElement?.innerText.split("\n")[0]?.trim();
    const channel = channels.find((c) => c.name?.trim() === name);
    if (!channel) return null;

    const locale = pageLocale();
    const value = (testid) =>
      section.querySelector(`[data-testid="${testid}"] [data-testid="channel-admin-insights-glance-value"]`)?.innerText;
    const reached = parseDisplayedNumber(value("channel-admin-insights-glance-reach"), locale);
    const net = parseDisplayedNumber(value("channel-admin-insights-glance-audience"), locale);

    return {
      id: channel.id,
      insights: {
        // under 100 followers WhatsApp shows just "— —"
        available: reached !== null || net !== null,
        accounts_reached: reached !== null && reached >= 0 ? reached : null,
        net_followers: net,
        period_days: parsePeriodDays(section.innerText),
      },
    };
  }

  // Stickers whose image the receiver already has (it says so on each
  // delivery): those go with the hash only, without the file.
  const knownStickers = new Set();

  /** Asks page.js for the loaded posts of these channels. */
  function requestPosts(ids) {
    return new Promise((ok) => {
      const request = Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener("message", listen);
        ok(null);
      }, 15_000);
      function listen(e) {
        if (e.source !== window || e.data?.channel !== CHANNEL || e.data.type !== "posts" || e.data.request !== request) return;
        clearTimeout(timeout);
        window.removeEventListener("message", listen);
        ok(e.data.ok ? e.data : null);
      }
      window.addEventListener("message", listen);
      window.postMessage({ channel: CHANNEL, type: "get-posts", ids, request, skipImages: [...knownStickers] }, "*");
    });
  }

  /** {channel|post id: {emoji: count}} from the reactions in the local database. */
  async function reactionsByPost(db, ids) {
    const all = await readAll(db, "newsletter-reactions");
    const map = {};
    for (const r of all) {
      const key = parentKey(r.parentMsgKey, ids);
      if (!key) continue;
      const byEmoji = {};
      for (const [emoji, n] of entriesOf(r.emojiCountMap)) {
        const total = toCount(n);
        if (Number.isFinite(total) && total > 0) byEmoji[emoji] = total;
      }
      map[key] = byEmoji;
    }
    return map;
  }

  /**
   * {channel|post id: {OPTION HASH: votes}} for polls and quizzes. The option
   * is the sha256 of its name in uppercase hex (same as `newsletter-my-votes`).
   */
  async function votesByPost(db, ids) {
    const all = await readAll(db, "newsletter-polls-votes");
    const map = {};
    for (const v of all) {
      const key = parentKey(v.parentMsgKey, ids);
      if (!key) continue;
      const byOption = {};
      for (const [hash, n] of entriesOf(v.votesMap)) {
        const total = toCount(n);
        if (Number.isFinite(total) && total >= 0) byOption[String(hash).toUpperCase()] = total;
      }
      map[key] = byOption;
    }
    return map;
  }

  async function sha256Hex(text) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  /**
   * Fills the poll votes from the local database tally. The page's tally
   * (pollVotesSnapshot) comes empty on channels; when the database has the
   * poll, an option missing from it got 0 votes.
   */
  async function withVotes(options, tally) {
    if (!options || !tally) return options;
    return Promise.all(
      options.map(async (o) => (o.votes !== null && o.votes !== undefined ? o : { ...o, votes: tally[await sha256Hex(o.name)] ?? 0 })),
    );
  }

  let lastDiagnostics = null;

  async function collect() {
    const db = await openDb();
    try {
      const all = await readAll(db, "newsletter-metadata");
      const ours = all.filter((c) => c.membershipType === ADMIN && !c.suspended);
      const fromScreen = insightsFromScreen(ours);
      const ids = ours.map((c) => c.id);
      const [fromPage, reactions, votes] = await Promise.all([requestPosts(ids), reactionsByPost(db, ids), votesByPost(db, ids)]);
      if (fromPage?.diagnostics) lastDiagnostics = fromPage.diagnostics;

      const channels = [];
      for (const c of ours) {
        const picture = await read(db, "profile-pic-thumb", c.id);
        channels.push({
          id: c.id,
          name: c.name || null,
          description: c.description || null,
          invite_code: c.inviteCode || null,
          created_at: c.creationTime ? new Date(c.creationTime * 1000).toISOString() : null,
          followers: typeof c.size === "number" ? c.size : null,
          picture_url: picture?.eurl || null,
          picture_tag: picture?.tag ? String(picture.tag) : null,
          insights: fromScreen && fromScreen.id === c.id ? fromScreen.insights : null,
          // null (not []) when the page didn't answer: the receiver must not
          // read "no posts" when the posts just couldn't be read
          posts: fromPage
            ? await Promise.all(
                (fromPage.channels[c.id] || []).slice(-MAX_POSTS).map(async ({ key, ...p }) => ({
                  ...p,
                  reactions: (key && reactions[`${c.id}|${key}`]) || null,
                  poll: p.poll && { ...p.poll, options: await withVotes(p.poll.options, key ? votes[`${c.id}|${key}`] : null) },
                })),
              )
            : null,
        });
      }
      return {
        schema: SCHEMA,
        extension_version: chrome.runtime.getManifest().version,
        collected_at: new Date().toISOString(),
        locale: pageLocale(),
        channels,
      };
    } finally {
      db.close();
    }
  }

  let busy = false;
  let lastSignature = "";

  async function collectAndDeliver(reason, { deliver = true } = {}) {
    if (busy) return { ok: false, error: t("errBusy") };
    busy = true;
    try {
      const payload = await collect();
      if (!payload.channels.length) return { ok: false, error: t("errNoChannels") };
      if (!deliver) return { ok: true, payload };
      const signature = signatureOf(payload.channels);
      if (reason !== "manual" && reason !== "interval" && signature === lastSignature) return { ok: true, unchanged: true };
      const result = await chrome.runtime.sendMessage({ type: "deliver", reason, payload, diagnostics: lastDiagnostics });
      if (result?.ok) {
        lastSignature = signature;
        for (const hash of result.knownStickerHashes || []) knownStickers.add(hash);
      }
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      busy = false;
    }
  }

  // WhatsApp Web takes a while to build its database after opening; retry a few times.
  async function firstRun(attempt = 0) {
    const result = await collectAndDeliver("startup");
    if (!result?.ok && attempt < 5) setTimeout(() => firstRun(attempt + 1), 20_000);
  }

  setTimeout(firstRun, 10_000);
  setInterval(() => collectAndDeliver("interval"), INTERVAL_MS);
  setInterval(() => collectAndDeliver("check"), CHECK_MS);

  // The insights screen of a channel opened (or changed): collect again.
  let pending = null;
  let insightsText = "";
  new MutationObserver(() => {
    const section = document.querySelector('[data-testid="channel-admin-insights-insights-section"]');
    const text = section?.innerText ?? "";
    if (!text || text === insightsText) return;
    insightsText = text;
    clearTimeout(pending);
    pending = setTimeout(() => collectAndDeliver("insights"), 1500);
  }).observe(document.body, { childList: true, subtree: true });

  /** Asks page.js for the raw post diagnostics. */
  function requestPageDiagnostics(ids) {
    return new Promise((ok) => {
      const request = Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener("message", listen);
        ok({ error: t("errPageSilent") });
      }, 5000);
      function listen(e) {
        if (e.source !== window || e.data?.channel !== CHANNEL || e.data.type !== "diagnostics" || e.data.request !== request) return;
        clearTimeout(timeout);
        window.removeEventListener("message", listen);
        ok(e.data.reply);
      }
      window.addEventListener("message", listen);
      window.postMessage({ channel: CHANNEL, type: "get-diagnostics", request, ids }, "*");
    });
  }

  /** Diagnostics for the popup: raw posts, channel-related local tables and samples of them. */
  async function fullDiagnostics() {
    const out = { version: chrome.runtime.getManifest().version, at: new Date().toISOString() };
    let ours = [];
    try {
      const db = await openDb();
      try {
        ours = (await readAll(db, "newsletter-metadata")).filter((c) => c.membershipType === ADMIN).map((c) => c.id);
      } finally {
        db.close();
      }
    } catch {
      // no database: the page diagnostics come complete
    }
    out.page = await requestPageDiagnostics(ours);
    try {
      const db = await openDb();
      try {
        out.tables = Array.from(db.objectStoreNames).filter((n) => /newsletter|reaction|poll|vote|addon/i.test(n));
        for (const name of out.tables) {
          if (name === "newsletter-metadata") continue;
          const items = await new Promise((ok) => {
            const r = db.transaction(name).objectStore(name).getAll(null, 6);
            r.onsuccess = () => ok(r.result || []);
            r.onerror = () => ok([]);
          });
          // a Map becomes an object: JSON.stringify of a Map is "{}"
          const readable = (_k, v) => (v instanceof Map ? { "(Map)": Object.fromEntries(v) } : v);
          out[`sample:${name}`] = JSON.stringify(items, readable).slice(0, 1500);
        }
      } finally {
        db.close();
      }
    } catch (e) {
      out.databaseError = String(e);
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === "diagnostics") {
      fullDiagnostics().then(respond, (e) => respond({ error: String(e) }));
      return true;
    }
    if (msg.type === "collect") {
      collectAndDeliver("manual", { deliver: msg.deliver !== false }).then(respond);
      return true;
    }
    return false;
  });
})();
