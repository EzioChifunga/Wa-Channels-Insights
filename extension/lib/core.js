// Pure helpers shared by the content script, the background worker and the
// tests. Loaded as a classic script (content scripts and importScripts don't
// take ES modules), so everything hangs off `globalThis.WCI`.
(function (root) {
  const SCHEMA = "wa-channels-insights/1";

  /** Number from a number, a protobuf Long ({low, high}) or a digit string; anything else is null. */
  function toNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    if (v && typeof v.low === "number") return v.low + (v.high || 0) * 2 ** 32;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    return null;
  }

  /** A count that may come as a number, a Long, a digit string or {count}; NaN when unknown. */
  function toCount(n) {
    if (typeof n === "number") return n;
    if (typeof n === "string" && /^\d+$/.test(n)) return Number(n);
    if (n && typeof n === "object") {
      if (typeof n.toNumber === "function") return n.toNumber();
      if (typeof n.low === "number") return n.low + (n.high || 0) * 2 ** 32;
      return toCount(n.count ?? n.voteCount ?? n.votes ?? n.total);
    }
    return NaN;
  }

  /** [key, value] pairs of a Map or a plain object (WhatsApp Web uses both). */
  function entriesOf(value) {
    if (!value) return [];
    if (value instanceof Map) return [...value.entries()];
    if (typeof value === "object") return Object.entries(value);
    return [];
  }

  /**
   * "true_<channel>@newsletter_AC0422BA…" → "<channel>@newsletter|AC0422BA…":
   * the key that ties reactions and poll tallies to a post (channel + short id).
   */
  function parentKey(parentMsgKey, ids) {
    if (typeof parentMsgKey !== "string") return null;
    const m = parentMsgKey.match(/^(?:true|false)_(\d+@newsletter)_([^_]+)/);
    return m && ids.includes(m[1]) ? `${m[1]}|${m[2]}` : null;
  }

  function decimalSeparator(locale) {
    try {
      return new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal")?.value || ".";
    } catch {
      return ".";
    }
  }

  const SCALES = { mil: 1e3, tsd: 1e3, k: 1e3, mio: 1e6, mln: 1e6, mi: 1e6, mn: 1e6, m: 1e6, bi: 1e9, bn: 1e9, b: 1e9 };
  // longest first, so "mil" doesn't stop at "mi" and "mi" doesn't stop at "m"
  const SCALE_PATTERN = Object.keys(SCALES)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const NUMBER_RE = new RegExp(`^([+-]?)\\s*([\\d.,]+)\\s*(${SCALE_PATTERN})?\\b`);

  /**
   * A number as WhatsApp Web displays it, in the page's language:
   * "1.234" / "1,234" → 1234 · "1,2 mil" (pt) / "1.2K" (en) → 1200 ·
   * "3,4 mi" / "3.4M" → 3400000 · "−5" → -5 · "— —" → null.
   */
  function parseDisplayedNumber(text, locale) {
    if (!text) return null;
    const t = text.replace(/−/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
    const m = t.match(NUMBER_RE);
    if (!m) return null;
    const [, sign, body, scale] = m;
    let value;
    if (scale) {
      // a fraction only shows up next to a scale ("1,2 mil"): the page's
      // decimal separator is the decimal point, the other one is grouping
      const decimal = decimalSeparator(locale) === "," ? "," : ".";
      const group = decimal === "," ? /\./g : /,/g;
      value = Number(body.replace(group, "").replace(decimal, "."));
      value *= SCALES[scale];
    } else {
      value = Number(body.replace(/[.,]/g, ""));
    }
    if (!Number.isFinite(value)) return null;
    return Math.round(sign === "-" ? -value : value);
  }

  /** "Last 30 days" / "Últimos 30 dias" → 30. */
  function parsePeriodDays(text) {
    const m = (text || "").match(/(\d+)\s*(?:dias|days|días|jours|tage|giorni|dagen|dni|gün|hari)/i);
    return Number(m?.[1] ?? 30);
  }

  /**
   * What tells two collections apart. The picture URL is signed and changes on
   * its own, and the sticker image only goes while the receiver doesn't have it,
   * so neither counts as a change.
   */
  function signatureOf(channels) {
    return JSON.stringify(
      channels.map(({ picture_url, ...rest }) => rest),
      (key, value) => (key === "image" ? undefined : value),
    );
  }

  function countPosts(channels) {
    return (channels || []).reduce((total, c) => total + (c.posts?.length || 0), 0);
  }

  root.WCI = { SCHEMA, toNumber, toCount, entriesOf, parentKey, parseDisplayedNumber, parsePeriodDays, signatureOf, countPosts };
  if (typeof module === "object" && module.exports) module.exports = root.WCI;
})(globalThis);
