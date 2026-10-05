# WA Channels Insights

A browser extension (Chrome, Brave, Edge — Manifest V3) that reads the data of
the **WhatsApp Channels you administer** from the WhatsApp Web tab you already
have open, and sends it where you choose: your own webhook, a JSON file, or
your app through an [integration](docs/INTEGRATIONS.md).

WhatsApp has no API for Channels. Instead of automating a parallel session
(which puts the number at risk of a ban), this extension only reads what
WhatsApp Web has already stored in your browser and what is on the screen. It
doesn't click, doesn't send messages and never makes its own requests to
WhatsApp.

> Unofficial project, not affiliated with WhatsApp or Meta. It depends on
> WhatsApp Web internals that can change without notice; when they do, the
> "Copy diagnostics" button helps find what moved.

## What it reads

| Data | Source |
|---|---|
| Name, description, creation date, invite code, followers | IndexedDB `model-storage` › `newsletter-metadata` (only `membershipType` 1: channels the account administers) |
| Picture | IndexedDB › `profile-pic-thumb` (a signed WhatsApp CDN URL and a version tag) |
| Posts: text, type, date, edit, deletion, views, forwards | The page's memory (`content/page.js`, world `MAIN`, `WAWebCollections.WAWebNewsletterCollection`) — in the local database posts are encrypted. Only posts WhatsApp Web has loaded: open each channel once |
| Polls and quizzes: options, votes, right answer | The post (`pollOptions`, `pollVotesSnapshot`) completed with the tally in IndexedDB › `newsletter-polls-votes`; options are matched by the sha256 of their name |
| Stickers | `filehash` (the same on every use of a sticker), animated/avatar flags, size, CDN `directPath` and — while your receiver doesn't have it — the image as a data URL, if WhatsApp Web already downloaded it |
| Emoji reactions per post | IndexedDB › `newsletter-reactions` |
| Accounts reached, net followers (last 30 days) | The **Channel insights** screen, when open. WhatsApp only shows them from 100 followers |

It collects when WhatsApp Web opens, every 2 minutes if something changed (new
post, reaction, view), every 15 minutes regardless and whenever a channel's
insights screen is opened. **Collect now** in the popup forces one.

## Install

1. Clone this repository.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`) and turn on **Developer mode**.
3. **Load unpacked** › choose the `extension/` folder.
4. Open the extension's **Settings** (popup › Settings) and set your webhook URL. The browser asks for permission to reach it.
5. Open or reload WhatsApp Web.

After pulling changes, click reload on the extension card and reload the
WhatsApp Web tab.

No server yet? **Export JSON** in the popup downloads a collection, and
[`examples/webhook-server.mjs`](examples/webhook-server.mjs) is a dependency-free receiver:

```sh
node examples/webhook-server.mjs            # http://localhost:8787/collect
TOKEN=secret node examples/webhook-server.mjs   # then set Authorization to "Bearer secret"
```

## What your webhook receives

`POST <your URL>` with `Content-Type: application/json` and, if set, your
`Authorization` header:

```jsonc
{
  "schema": "wa-channels-insights/1",
  "extension_version": "1.0.0",
  "collected_at": "2026-10-05T14:03:11.000Z",
  "locale": "pt-BR",                       // WhatsApp Web's language
  "channels": [
    {
      "id": "120363000000000001@newsletter",
      "name": "My channel",                // null if empty
      "description": "…",
      "invite_code": "0029VaAbCdEfGhIjKlMn0p",
      "created_at": "2023-11-14T22:13:20.000Z",
      "followers": 1234,
      "picture_url": "https://pps.whatsapp.net/…",   // signed, expires — download it if you want to keep it
      "picture_tag": "1699999999",                    // changes when the picture changes
      "insights": {                         // null unless the insights screen was open
        "available": true,                  // false under 100 followers
        "accounts_reached": 1200,
        "net_followers": -5,                // can be negative
        "period_days": 30
      },
      "posts": [                            // null = posts couldn't be read this time (not "no posts")
        {
          "id": "101",                      // the post's server id in the channel
          "type": "text",                   // text | image | video | audio | poll | sticker | document | other
          "text": "Good morning!",          // body, caption or poll question
          "published_at": "2023-11-14T22:15:00.000Z",
          "edited_at": null,
          "deleted": false,
          "views": 5,
          "forwards": 2,
          "reactions": { "❤️": 3, "👍": 2 },
          "poll": null,                     // or { "options": [{ "name", "votes", "correct"? }], "multiple", "quiz" }
          "sticker": null                   // or { "hash", "animated", "avatar", "width", "height", "direct_path", "image" }
        }
      ]
    }
  ]
}
```

Notes for receivers:

- Up to the last 300 loaded posts per channel. Treat each delivery as a
  snapshot: upsert posts by `channel.id` + `post.id`.
- `poll.options[].votes` is `null` when no tally was loaded (unknown, not
  zero). `correct` only exists on quizzes.
- `sticker.image` (a `data:image/webp;base64,…` URL) is sent until you list
  the hash in `known_sticker_hashes` in your response. `direct_path` is the
  path on WhatsApp's media CDN (`https://mmg.whatsapp.net<direct_path>`);
  channel media isn't end-to-end encrypted.
- `picture_url` only accepts WhatsApp's CDN — if you download it server-side,
  check that it starts with `https://pps.whatsapp.net/` so it can't be used to
  make your server fetch arbitrary URLs.

Respond with any `2xx`. The body is optional:

```json
{ "known_sticker_hashes": ["q83vEjRWeJA0Qj0vNwKcWm0bsZ9+lCk="], "summary": "3 new posts" }
```

`summary` is shown in the popup. On errors, a JSON body `{ "error": "…" }` is
shown to the user.

## Integrations

Need your own authentication or body format? Build the extension with an
integration — a folder with an `integration.js` that replaces the delivery,
the popup status and can add content scripts:

```sh
node scripts/build.mjs --integration ../my-integration --out ../my-integration-dist
```

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Privacy

- Data leaves the browser only to the destination you configure (or your
  integration's).
- Only channels the account **administers** are read; channels it merely
  follows, chats and groups are never read.
- Diagnostics include field names and counts, never post text.

## Project layout

```
extension/            the extension (load this folder unpacked)
  manifest.json
  background.js       delivery: integration or webhook
  content/collector.js  reads IndexedDB and the insights screen (isolated world)
  content/page.js       reads posts from WhatsApp Web's memory (MAIN world)
  lib/core.js         pure helpers shared with the tests
  integration/        empty default; replaced by --integration
  popup/  options/  _locales/ (en, pt_BR)
scripts/build.mjs     builds extension + integration into one folder
testing/              fake WhatsApp Web tab to run the content scripts in Node
test/                 node --test
examples/             a minimal webhook receiver
docs/INTEGRATIONS.md
```

## Development

Node 20+, no dependencies:

```sh
npm test                 # or: node --test
node scripts/build.mjs   # → dist/
```

When WhatsApp Web changes: the `data-testid` selectors are in
`content/collector.js`, the IndexedDB table names in the same file, and the
post fields in `content/page.js`. **Copy diagnostics** in the popup copies the
raw field names of recent posts (without their text) to compare.

## License

[MIT](LICENSE)
