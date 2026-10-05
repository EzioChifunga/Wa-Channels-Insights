#!/usr/bin/env node
// Minimal receiver for WA Channels Insights, to try the extension or start
// your own. No dependencies.
//
//   node examples/webhook-server.mjs                 → http://localhost:8787/collect
//   PORT=9000 TOKEN=secret node examples/webhook-server.mjs
//
// With TOKEN set, set the extension's Authorization header to "Bearer secret".
// Each collection is printed and saved to ./collections/<timestamp>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.TOKEN || "";
const MAX_BODY = 20 * 1024 * 1024;

// sticker hashes whose image we already stored: the extension stops sending those files
const knownStickers = new Set();

function reply(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    // the extension holds a host permission and doesn't need CORS; this only
    // helps when you test from a regular page
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  if (req.method === "OPTIONS") return reply(res, 204, {});
  if (req.method !== "POST" || req.url !== "/collect") return reply(res, 404, { error: "POST /collect" });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return reply(res, 401, { error: "Invalid token" });

  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(res, 400, { error: "Invalid JSON" });
    }
    if (payload?.schema !== "wa-channels-insights/1") return reply(res, 400, { error: "Unknown schema" });

    mkdirSync("collections", { recursive: true });
    writeFileSync(`collections/${payload.collected_at.replace(/[:.]/g, "-")}.json`, JSON.stringify(payload, null, 2));

    let posts = 0;
    for (const channel of payload.channels) {
      posts += channel.posts?.length || 0;
      for (const post of channel.posts || []) if (post.sticker?.image) knownStickers.add(post.sticker.hash);
      const insights = channel.insights?.available ? ` · reached ${channel.insights.accounts_reached}` : "";
      console.log(`${channel.name ?? channel.id}: ${channel.followers ?? "?"} followers · ${channel.posts?.length ?? "no"} posts${insights}`);
    }
    reply(res, 200, { known_sticker_hashes: [...knownStickers], summary: `${posts} post(s) stored` });
  });
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}/collect`));
