import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { A, B, STICKER_HASH, fixture } from "../testing/fixture.mjs";
import { createTab } from "../testing/harness.mjs";

const file = (path) => fileURLToPath(new URL(`../extension/${path}`, import.meta.url));

function openTab(data, options) {
  const tab = createTab(data, options);
  tab.load(file("lib/core.js"));
  tab.load(file("content/collector.js"));
  tab.load(file("content/page.js"));
  return tab;
}

test("collects only the channels the account administers", async () => {
  const { ok, payload } = await openTab(fixture()).message({ type: "collect", deliver: false });
  assert.equal(ok, true);
  assert.equal(payload.schema, "wa-channels-insights/1");
  assert.equal(payload.locale, "pt-BR");
  assert.deepEqual(
    payload.channels.map((c) => c.id),
    [A, B],
  );

  const [a, b] = payload.channels;
  assert.deepEqual(
    { ...a, posts: undefined },
    {
      id: A,
      name: "Canal A",
      description: "Receitas e dicas",
      invite_code: "0029VaAbCdEfGhIjKlMn0p",
      created_at: "2023-11-14T22:13:20.000Z",
      followers: 1234,
      picture_url: "https://pps.whatsapp.net/v/t61.24694-24/abc.jpg?oh=1",
      picture_tag: "1699999999",
      insights: { available: true, accounts_reached: 1200, net_followers: -5, period_days: 30 },
      posts: undefined,
    },
  );
  assert.deepEqual(b, {
    id: B,
    name: null,
    description: null,
    invite_code: null,
    created_at: null,
    followers: null,
    picture_url: null,
    picture_tag: null,
    insights: null,
    posts: [],
  });
});

test("reads posts with reactions, polls and stickers", async () => {
  const { payload } = await openTab(fixture()).message({ type: "collect", deliver: false });
  const posts = Object.fromEntries(payload.channels[0].posts.map((p) => [p.id, p]));

  assert.equal(payload.channels[0].posts.length, 10, "the system notice is not a post");
  assert.deepEqual(posts["101"], {
    id: "101",
    type: "text",
    text: "Bom dia!",
    published_at: "2023-11-14T22:15:00.000Z",
    edited_at: null,
    deleted: false,
    views: 5,
    forwards: 2,
    poll: null,
    sticker: null,
    reactions: { "❤️": 3, "👍": 2 },
  });
  assert.equal(posts["102"].type, "image");
  assert.equal(posts["102"].text, "Salada");
  assert.equal(posts["102"].views, 40);
  assert.equal(posts["102"].edited_at, "2023-11-14T22:18:20.000Z");
  assert.deepEqual(posts["102"].reactions, { "🔥": 7 });

  // empty tally on the page: votes come from the local database, missing option = 0
  assert.deepEqual(posts["103"].poll, {
    options: [
      { name: "Sim", votes: 4 },
      { name: "Não", votes: 1 },
      { name: "Talvez", votes: 0 },
    ],
    multiple: true,
    quiz: false,
  });
  // tally on the page, matched by name; quiz carries the right answer
  assert.deepEqual(posts["104"].poll, {
    options: [
      { name: "1 L", votes: 0, correct: false },
      { name: "2 L", votes: 3, correct: true },
    ],
    multiple: false,
    quiz: true,
  });

  assert.deepEqual(posts["105"].sticker, {
    hash: STICKER_HASH,
    animated: true,
    avatar: false,
    width: 512,
    height: 512,
    direct_path: "/v/t62.15575-24/123_456.enc?ccb=11-4&oh=01",
    image: "data:image/webp;base64,UklGRgECAw==",
  });
  assert.equal(posts["106"].deleted, true);
  assert.equal(posts["106"].type, "other");
  assert.equal(posts["107"].type, "video");
  assert.equal(posts["108"].type, "audio");
  assert.equal(posts["109"].type, "document");
  assert.equal(posts["110"].type, "other");
  assert.ok(Object.values(posts).every((p) => !("key" in p)), "the internal key doesn't leave the collector");
});

test("delivers through the background and stops resending known sticker images", async () => {
  const tab = openTab(fixture(), { reply: () => ({ ok: true, knownStickerHashes: [STICKER_HASH] }) });
  const first = await tab.message({ type: "collect" });
  assert.equal(first.ok, true);
  assert.equal(tab.sent.length, 1);
  assert.equal(tab.sent[0].type, "deliver");
  assert.equal(tab.sent[0].reason, "manual");
  const sticker = (msg) => msg.payload.channels[0].posts.find((p) => p.type === "sticker").sticker;
  assert.ok(sticker(tab.sent[0]).image);
  assert.ok(tab.sent[0].diagnostics.sticker, "carries a raw sample for diagnostics");

  await tab.message({ type: "collect" });
  assert.equal(sticker(tab.sent[1]).image, null);
  assert.equal(sticker(tab.sent[1]).hash, STICKER_HASH);
});

test("keeps the sticker image while the destination doesn't confirm it", async () => {
  const tab = openTab(fixture(), { reply: () => ({ ok: false, error: "down" }) });
  const r = await tab.message({ type: "collect" });
  assert.deepEqual(r, { ok: false, error: "down" });
  await tab.message({ type: "collect" });
  assert.ok(tab.sent[1].payload.channels[0].posts.find((p) => p.type === "sticker").sticker.image);
});

test("reads insights in English", async () => {
  const data = fixture({ insights: { reach: "1.2K", audience: "-5", period: "Last 30 days" } });
  const { payload } = await openTab(data, { lang: "en" }).message({ type: "collect", deliver: false });
  assert.deepEqual(payload.channels[0].insights, { available: true, accounts_reached: 1200, net_followers: -5, period_days: 30 });
});

test("insights under 100 followers are unavailable", async () => {
  const data = fixture({ insights: { reach: "— —", audience: "— —", period: "Últimos 30 dias" } });
  const { payload } = await openTab(data).message({ type: "collect", deliver: false });
  assert.deepEqual(payload.channels[0].insights, { available: false, accounts_reached: null, net_followers: null, period_days: 30 });
});

test("waits for the page instead of reporting no posts", async () => {
  const tab = createTab(fixture());
  tab.load(file("lib/core.js"));
  tab.load(file("content/collector.js"));
  // page.js not injected: the request times out — in the harness the 15 s
  // timeout never fires, so answer the request with a failure instead
  const pending = tab.message({ type: "collect", deliver: false });
  const result = await Promise.race([pending, new Promise((r) => setTimeout(() => r("timeout"), 300))]);
  assert.equal(result, "timeout", "waits for the page instead of reporting no posts");
});

test("no administered channel is an error", async () => {
  const data = fixture();
  data.stores["newsletter-metadata"] = data.stores["newsletter-metadata"].filter((c) => c.membershipType !== 1);
  const r = await openTab(data).message({ type: "collect" });
  assert.deepEqual(r, { ok: false, error: "errNoChannels" });
});

test("diagnostics never include post text", async () => {
  const r = await openTab(fixture()).message({ type: "diagnostics" });
  const text = JSON.stringify(r);
  assert.ok(r.page.channels.length >= 1);
  assert.ok(r.tables.includes("newsletter-reactions"));
  assert.ok(!text.includes("Bom dia!"));
});
