// What WhatsApp Web would have in a tab of an account that administers two
// channels: the shapes follow what the collector reads in the real thing,
// including the awkward ones (Map counts, protobuf Longs, empty poll tallies).
import { createHash } from "node:crypto";

export const A = "120363000000000001@newsletter";
export const B = "120363000000000002@newsletter";
const FOLLOWED = "120363000000000003@newsletter";
const SUSPENDED = "120363000000000004@newsletter";

export const STICKER_HASH = "q83vEjRWeJA0Qj0vNwKcWm0bsZ9+lCk=";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const id = (channel, short) => ({ id: short, _serialized: `true_${channel}_${short}` });
const msg = (attributes, extra = {}) => ({ attributes, ...extra });

function element(innerText, children = {}) {
  return { innerText, querySelector: (selector) => children[selector] ?? null };
}

const glance = (testid) => `[data-testid="${testid}"] [data-testid="channel-admin-insights-glance-value"]`;

/** @param insights the values on the "Channel insights" screen, or null when it isn't open */
export function fixture({ insights = { reach: "1,2 mil", audience: "−5", period: "Últimos 30 dias" } } = {}) {
  return {
    stores: {
      "newsletter-metadata": [
        {
          id: A,
          membershipType: 1,
          name: "Canal A",
          description: "Receitas e dicas",
          inviteCode: "0029VaAbCdEfGhIjKlMn0p",
          creationTime: 1700000000,
          size: 1234,
        },
        { id: B, membershipType: 1, name: "", creationTime: 0 },
        { id: FOLLOWED, membershipType: 2, name: "Someone else's", size: 99 },
        { id: SUSPENDED, membershipType: 1, name: "Suspended", suspended: true },
      ],
      "profile-pic-thumb": [{ id: A, eurl: "https://pps.whatsapp.net/v/t61.24694-24/abc.jpg?oh=1", tag: 1699999999 }],
      "newsletter-reactions": [
        { parentMsgKey: `true_${A}_TXT1`, emojiCountMap: new Map([["❤️", 3], ["👍", { low: 2, high: 0 }], ["😂", 0]]) },
        { parentMsgKey: `true_${A}_IMG1`, emojiCountMap: { "🔥": "7" } },
        { parentMsgKey: `true_${FOLLOWED}_XX1`, emojiCountMap: new Map([["❤️", 50]]) },
      ],
      "newsletter-polls-votes": [
        {
          parentMsgKey: `true_${A}_POLL1`,
          votesMap: new Map([
            [sha("Sim").toUpperCase(), 4],
            [sha("Não"), { low: 1, high: 0 }],
          ]),
        },
      ],
      "newsletter-my-votes": [],
    },
    newsletters: {
      [A]: [
        msg({ type: "newsletter_notification", id: id(A, "N1"), t: 1700000001 }),
        msg({ type: "chat", body: "Bom dia!", serverId: 101, id: id(A, "TXT1"), t: 1700000100, viewCount: { low: 5, high: 0 }, forwardsCount: 2 }),
        msg({
          type: "image",
          caption: "Salada",
          serverId: 102,
          id: id(A, "IMG1"),
          t: 1700000200,
          latestEditSenderTimestampMs: 1700000300000,
          viewCount: "40",
        }),
        msg({
          type: "poll_creation",
          pollName: "Gostou?",
          serverId: 103,
          id: id(A, "POLL1"),
          t: 1700000400,
          pollOptions: [
            { name: "Sim", localId: 0 },
            { name: "Não", localId: 1 },
            { name: "Talvez", localId: 2 },
          ],
          pollVotesSnapshot: { pollVotes: [] },
          pollSelectableOptionsCount: 0,
        }),
        msg({
          type: "poll_creation",
          pollName: "Quanto de água por dia?",
          serverId: 104,
          id: id(A, "QUIZ1"),
          t: 1700000500,
          pollType: 1,
          correctOptionIndex: 1,
          pollOptions: [{ name: "1 L" }, { name: "2 L" }],
          pollVotesSnapshot: { pollVotes: [{ option: { name: "2 L" }, optionVoteCount: { low: 3, high: 0 } }] },
          pollSelectableOptionsCount: 1,
        }),
        msg(
          {
            type: "sticker",
            serverId: 105,
            id: id(A, "STK1"),
            t: 1700000600,
            filehash: STICKER_HASH,
            isAnimated: true,
            width: 512,
            height: 512,
            directPath: "/v/t62.15575-24/123_456.enc?ccb=11-4&oh=01",
          },
          { mediaData: { mediaBlob: new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], { type: "image/webp" }) } },
        ),
        msg({ type: "revoked", serverId: 106, id: id(A, "DEL1"), t: 1700000700 }),
        msg({ type: "gif", caption: "", serverId: 107, id: id(A, "GIF1"), t: 1700000800 }),
        msg({ type: "ptt", serverId: 108, id: { _serialized: `true_${A}_PTT1` }, t: 1700000900 }),
        msg({ type: "document", caption: "Cardápio", serverId: 109, id: id(A, "DOC1"), t: 1700001000 }),
        msg({ type: "location", serverId: 110, id: id(A, "LOC1"), t: 1700001100 }),
      ],
    },
    dom: insights
      ? {
          '[data-testid="channel-admin-insights-insights-section"]': element(`${insights.period}\nContas alcançadas\n${insights.reach}`, {
            [glance("channel-admin-insights-glance-reach")]: element(insights.reach),
            [glance("channel-admin-insights-glance-audience")]: element(insights.audience),
          }),
          '[data-testid="newsletter-info-top-card-subtitle"]': { parentElement: { innerText: "Canal A\nCanal · 1.234 seguidores" } },
        }
      : {},
  };
}
