import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const WCI = createRequire(import.meta.url)("../extension/lib/core.js");

test("parseDisplayedNumber reads Portuguese numbers", () => {
  const n = (text) => WCI.parseDisplayedNumber(text, "pt-BR");
  assert.equal(n("1.234"), 1234);
  assert.equal(n("1,2 mil"), 1200);
  assert.equal(n("3,4 mi"), 3400000);
  assert.equal(n("3,4 M"), 3400000);
  assert.equal(n("2 bi"), 2000000000);
  assert.equal(n("−5"), -5);
  assert.equal(n("+12"), 12);
  assert.equal(n("— —"), null);
  assert.equal(n(""), null);
  assert.equal(n(undefined), null);
});

test("parseDisplayedNumber reads English numbers", () => {
  const n = (text) => WCI.parseDisplayedNumber(text, "en");
  assert.equal(n("1,234"), 1234);
  assert.equal(n("1.2K"), 1200);
  assert.equal(n("3.4M"), 3400000);
  assert.equal(n("1.5B"), 1500000000);
  assert.equal(n("-5"), -5);
});

test("parseDisplayedNumber reads other locales", () => {
  assert.equal(WCI.parseDisplayedNumber("1,5 Mio.", "de"), 1500000);
  assert.equal(WCI.parseDisplayedNumber("2,5 k", "fr"), 2500);
  assert.equal(WCI.parseDisplayedNumber("1,2 mil", "es"), 1200);
});

test("parsePeriodDays", () => {
  assert.equal(WCI.parsePeriodDays("Últimos 30 dias"), 30);
  assert.equal(WCI.parsePeriodDays("Last 7 days"), 7);
  assert.equal(WCI.parsePeriodDays("whatever"), 30);
});

test("toCount and toNumber accept Longs and strings", () => {
  assert.equal(WCI.toCount({ low: 2, high: 0 }), 2);
  assert.equal(WCI.toCount({ count: "4" }), 4);
  assert.ok(Number.isNaN(WCI.toCount(null)));
  assert.equal(WCI.toNumber({ low: 1, high: 1 }), 2 ** 32 + 1);
  assert.equal(WCI.toNumber("12"), 12);
  assert.equal(WCI.toNumber("12a"), null);
});

test("entriesOf reads Maps and objects", () => {
  assert.deepEqual(WCI.entriesOf(new Map([["a", 1]])), [["a", 1]]);
  assert.deepEqual(WCI.entriesOf({ b: 2 }), [["b", 2]]);
  assert.deepEqual(WCI.entriesOf(null), []);
});

test("parentKey ties a reaction to a post of one of our channels", () => {
  const ids = ["123456@newsletter"];
  assert.equal(WCI.parentKey("true_123456@newsletter_AC04", ids), "123456@newsletter|AC04");
  assert.equal(WCI.parentKey("false_123456@newsletter_AC04_x", ids), "123456@newsletter|AC04");
  assert.equal(WCI.parentKey("true_999999@newsletter_AC04", ids), null);
  assert.equal(WCI.parentKey(42, ids), null);
});

test("signatureOf ignores the picture URL and sticker images", () => {
  const channel = (pictureUrl, image) => [{ id: "1", picture_url: pictureUrl, posts: [{ sticker: { hash: "h", image } }] }];
  assert.equal(WCI.signatureOf(channel("a", "data:1")), WCI.signatureOf(channel("b", null)));
  assert.notEqual(WCI.signatureOf(channel("a", null)), WCI.signatureOf([{ id: "2", picture_url: "a", posts: [] }]));
});
