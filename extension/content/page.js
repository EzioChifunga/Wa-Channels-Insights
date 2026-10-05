// Runs INSIDE the WhatsApp Web page (world MAIN), because channel posts only
// exist decrypted in the page's own memory — in the local database they are
// encrypted. Read-only: it takes the posts WhatsApp Web has already loaded
// (opening a channel loads the recent ones) and hands them to collector.js
// through window.postMessage. It never calls a WhatsApp function that talks
// to the server.
(() => {
  const CHANNEL = "wa-channels-insights";

  const TYPES = {
    chat: "text",
    image: "image",
    video: "video",
    gif: "video",
    ptt: "audio",
    audio: "audio",
    poll_creation: "poll",
    sticker: "sticker",
    document: "document",
  };
  // channel system notices ("channel created", "privacy"…) are not posts
  const IGNORE = new Set(["newsletter_notification", "e2e_notification", "notification_template", "gp2"]);

  // Sticker image: only the ones WhatsApp Web has already downloaded (on screen
  // or scrolled past), a few per run and only those the receiver doesn't have
  // yet — the others go with the hash only.
  const MAX_IMAGES = 8;
  const MAX_IMAGE_BYTES = 400 * 1024;

  function collections() {
    try {
      return window.require("WAWebCollections");
    } catch {
      return null;
    }
  }

  /** Number, including the protobuf Long ({low, high}); anything else is null. */
  function toNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    if (v && typeof v.low === "number") return v.low + (v.high || 0) * 2 ** 32;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    return null;
  }

  function hexOf(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** A hash as text: strings as they come; bytes become hex and base64 (either may be what the other side uses). */
  function hashTexts(h) {
    if (h == null) return [];
    if (typeof h === "string") return [h];
    const bytes = h instanceof Uint8Array ? h : Array.isArray(h) ? Uint8Array.from(h) : null;
    return bytes ? [hexOf(bytes), btoa(String.fromCharCode(...bytes))] : [];
  }

  /** The hash WhatsApp uses for a channel poll option: sha256 of its name, in hex and base64. */
  async function hashesOfName(name) {
    try {
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));
      return [hexOf(bytes), btoa(String.fromCharCode(...bytes))];
    } catch {
      return [];
    }
  }

  /**
   * Options and votes of a channel poll.
   *
   * The post keeps the options in `pollOptions` ({name, localId, hash?}) and
   * the tally in `pollVotesSnapshot.pollVotes`, one item per option:
   * {option: {name, hash}, optionVoteCount}. A tally item is matched to its
   * option by hash, by name, by localId and, last, by position. Without a
   * tally (or with an empty list, the usual on channels) votes go as null and
   * collector.js fills them from the local database; with a tally, an option
   * missing from it got 0.
   */
  async function poll(a) {
    const options = (a.pollOptions || []).map((o, i) => ({
      name: String(o.name ?? o.optionName ?? ""),
      localId: o.localId ?? o.id ?? i,
      hash: o.hash ?? null,
      votes: null,
    }));
    if (!options.length) return null;

    const snap = a.pollVotesSnapshot;
    const tally = Array.isArray(snap) ? snap : snap?.pollVotes || snap?.votes || null;
    // empty means "unknown" (collector.js fills it), not "everybody got 0"
    if (Array.isArray(tally) && tally.length) {
      const hashes = await Promise.all(options.map(async (o) => [...hashTexts(o.hash), ...(await hashesOfName(o.name))]));
      const used = new Set();
      tally.forEach((v, position) => {
        const target = v.option || v;
        const name = target.name ?? target.optionName ?? null;
        const voteHash = hashTexts(target.hash);
        const localId = v.localId ?? v.optionLocalId ?? target.localId;
        let i = voteHash.length ? hashes.findIndex((h) => voteHash.some((x) => h.includes(x))) : -1;
        if (i < 0 && name !== null) i = options.findIndex((o) => o.name === name);
        if (i < 0 && localId !== undefined) i = options.findIndex((o) => o.localId === localId);
        if (i < 0 && tally.length === options.length && !used.has(position)) i = position;
        const votes = toNumber(v.optionVoteCount ?? v.voteCount ?? v.count ?? v.votes);
        if (i >= 0 && votes !== null) {
          options[i].votes = votes;
          used.add(i);
        }
      });
      for (const o of options) if (o.votes === null) o.votes = 0;
    }

    // quiz: a poll with a right answer (pollType 1 / "QUIZ")
    const quiz = a.pollType === 1 || a.pollType === "QUIZ";
    const correct = quiz ? toNumber(a.correctOptionIndex) : null;
    return {
      options: options.map(({ name, votes }, i) => ({ name, votes, ...(quiz ? { correct: i === correct } : {}) })),
      multiple: (a.pollSelectableOptionsCount ?? 1) !== 1,
      quiz,
    };
  }

  /** The sticker file, if WhatsApp Web has already downloaded it: a webp data URL. */
  async function stickerImage(msg) {
    const md = msg.mediaData || msg.attributes?.mediaData;
    if (!md) return null;
    let blob = null;
    const b = md.mediaBlob;
    for (const c of [b?._blob, b?.blob, b]) {
      if (c instanceof Blob) {
        blob = c;
        break;
      }
    }
    if (!blob) {
      const urls = [md.renderableUrl, typeof b?.url === "function" ? b.url() : null];
      const url = urls.find((u) => typeof u === "string" && /^(blob|data):/.test(u));
      if (url) blob = await (await fetch(url)).blob();
    }
    if (!blob || blob.size > MAX_IMAGE_BYTES) return null;
    return new Promise((ok) => {
      const reader = new FileReader();
      reader.onload = () => ok(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => ok(null);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * The post's sticker. `filehash` (sha256 of the file) is the same every time
   * the same sticker is used — it's what groups the uses together.
   */
  async function sticker(msg, a, run) {
    const hash = a.filehash || a.mediaData?.filehash;
    if (!hash) return null;
    const data = {
      hash: String(hash),
      animated: !!a.isAnimated,
      avatar: !!a.isAvatar,
      width: toNumber(a.width),
      height: toNumber(a.height),
      // channels have no end-to-end encryption: with the CDN path the receiver
      // can fetch a sticker the browser hasn't downloaded yet
      direct_path: typeof a.directPath === "string" ? a.directPath : null,
      image: null,
    };
    if (!run.skip.has(data.hash) && run.images < MAX_IMAGES) {
      try {
        data.image = await stickerImage(msg);
      } catch {
        data.image = null;
      }
      if (data.image) {
        run.images += 1;
        run.skip.add(data.hash);
      }
    }
    return data;
  }

  /**
   * The post's short id ("AC0422BA…"), the same that ends the `parentMsgKey`
   * of reactions and poll tallies in the local database. The key's
   * `_serialized` doesn't always exist on WhatsApp Web's model.
   */
  function shortId(a) {
    const id = a.id;
    if (!id) return null;
    if (typeof id.id === "string") return id.id;
    const text = id._serialized || (typeof id.toString === "function" ? id.toString() : "");
    return typeof text === "string" && text.includes("_") ? text.split("_").pop() : null;
  }

  async function post(msg, run) {
    const a = msg.attributes || msg;
    if (IGNORE.has(a.type)) return null;
    const deleted = a.type === "revoked" || !!a.revokeTimestamp;
    const type = deleted ? "other" : TYPES[a.type] || "other";
    const text = (type === "text" ? a.body : type === "poll" ? a.pollName : a.caption) || null;
    return {
      id: String(a.serverId ?? a.id?.id ?? a.id?._serialized),
      key: shortId(a),
      type,
      text: typeof text === "string" ? text : null,
      published_at: new Date((a.t || 0) * 1000).toISOString(),
      edited_at: a.latestEditSenderTimestampMs ? new Date(a.latestEditSenderTimestampMs).toISOString() : null,
      deleted,
      views: toNumber(a.viewCount),
      forwards: toNumber(a.forwardsCount),
      poll: type === "poll" ? await poll(a) : null,
      sticker: type === "sticker" ? await sticker(msg, a, run) : null,
    };
  }

  // Raw shape of a post (no text, no media), to debug when WhatsApp renames
  // fields. The popup copies this.
  const DIAGNOSTIC_FIELDS =
    /serverId|type|^t$|view|forward|poll|correct|reac|edit|revoke|filehash|isAnimated|isAvatar|directPath|mimetype|width|height/i;

  function diagnostic(msg) {
    const a = msg.attributes || {};
    const fields = {};
    for (const k of Object.keys(a)) {
      if (!DIAGNOSTIC_FIELDS.test(k)) continue;
      const v = a[k];
      try {
        fields[k] = v == null || typeof v !== "object" ? v : JSON.stringify(v).slice(0, 600);
      } catch {
        fields[k] = "(not serializable)";
      }
    }
    const md = msg.mediaData;
    if (md) fields.mediaData = Object.keys(md.attributes || md).join(",").slice(0, 600);
    return fields;
  }

  async function readPosts(ids, skip) {
    const C = collections();
    const NL = C?.WAWebNewsletterCollection;
    if (!NL) return { ok: false, error: "WhatsApp Web is still loading" };
    const run = { skip: new Set(skip), images: 0 };
    const channels = {};
    // one sample of each type that tends to break, for diagnostics
    const samples = {};
    for (const id of ids) {
      const model = NL.get(id);
      const msgs = model?.msgs?._models || [];
      const posts = [];
      for (const m of msgs) {
        try {
          const p = await post(m, run);
          if (p) {
            posts.push(p);
            if (!samples[p.type] || p.type === "poll" || p.type === "sticker") samples[p.type] = diagnostic(m);
          }
        } catch {
          // one odd post doesn't take the others down
        }
      }
      channels[id] = posts;
    }
    return { ok: true, channels, diagnostics: samples };
  }

  // Full diagnostics ("Copy diagnostics" in the popup): raw fields of the last
  // posts of each channel related to reactions, polls and stickers, and the
  // WhatsApp Web collections with those names. Never the post text.
  const FULL_DIAGNOSTIC_FIELDS =
    /poll|reac|vote|sticker|filehash|animated|avatar|directPath|view|forward|count|addon|correct|mimetype|width|height/i;

  function fullDiagnostics(ids) {
    const C = collections();
    if (!C) return { error: "WAWebCollections unavailable" };
    const out = {
      collections: Object.keys(C).filter((k) => /newsletter|reaction|poll|vote|sticker|addon/i.test(k)),
      channels: [],
    };
    const NL = C.WAWebNewsletterCollection;
    const list = (NL?.getModelsArray && NL.getModelsArray()) || NL?._models || [];
    for (const n of list) {
      if (ids?.length && !ids.includes(n.id?._serialized || String(n.id))) continue;
      const msgs = n.msgs?._models || [];
      const channel = { id: n.id?._serialized || String(n.id), loaded: msgs.length, posts: [] };
      for (const m of msgs.slice(-12)) {
        const a = m.attributes || m;
        const p = { type: a.type, serverId: a.serverId, id: a.id?._serialized };
        for (const k of Object.keys(a)) {
          if (!FULL_DIAGNOSTIC_FIELDS.test(k)) continue;
          const v = a[k];
          try {
            p[k] = v == null || typeof v !== "object" ? v : JSON.stringify(v).slice(0, 800);
          } catch {
            p[k] = "(not serializable)";
          }
        }
        const md = m.mediaData;
        if (md) p.mediaData = Object.keys(md.attributes || md).join(",").slice(0, 600);
        p.key = shortId(a);
        channel.posts.push(p);
      }
      out.channels.push(channel);
    }
    return out;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.channel !== CHANNEL || e.data.type !== "get-diagnostics") return;
    let reply;
    try {
      reply = fullDiagnostics(e.data.ids);
    } catch (error) {
      reply = { error: String(error) };
    }
    window.postMessage({ channel: CHANNEL, type: "diagnostics", request: e.data.request, reply }, "*");
  });

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.channel !== CHANNEL || e.data.type !== "get-posts") return;
    let reply;
    try {
      reply = await readPosts(e.data.ids || [], e.data.skipImages || []);
    } catch (error) {
      reply = { ok: false, error: String(error) };
    }
    window.postMessage({ channel: CHANNEL, type: "posts", request: e.data.request, ...reply }, "*");
  });
})();
