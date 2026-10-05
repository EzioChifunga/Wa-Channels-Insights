// A fake WhatsApp Web tab to run the content scripts unchanged in Node: the
// local IndexedDB, WhatsApp Web's in-memory collections, the bits of DOM the
// collector looks at and the `chrome.*` APIs it calls.
//
// The scripts run in this same realm (not a vm context) on purpose: the
// collector checks `instanceof Map` / `instanceof Blob` on fixture values.
import { readFileSync } from "node:fs";

function fakeIndexedDB(stores) {
  const names = Object.keys(stores);
  const db = {
    objectStoreNames: Object.assign([...names], { contains: (n) => names.includes(n) }),
    transaction(store) {
      const records = stores[store] || [];
      const answer = (result) => {
        const request = {};
        setImmediate(() => {
          request.result = result;
          request.onsuccess?.();
        });
        return request;
      };
      return {
        objectStore: () => ({
          getAll: (_query, count) => answer(count ? records.slice(0, count) : [...records]),
          get: (key) => answer(records.find((r) => r.id === key)),
        }),
      };
    },
    close() {},
  };
  return {
    open() {
      const request = {};
      setImmediate(() => {
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    },
  };
}

class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

/**
 * @param fixture {stores, newsletters: {id: [msg models]}, dom: {selector: element}}
 * @param options.lang  the `lang` WhatsApp Web sets on <html>
 * @param options.reply what chrome.runtime.sendMessage answers (a function of the message)
 */
export function createTab(fixture, { lang = "pt-BR", reply = () => ({ ok: true }), version = "test" } = {}) {
  const listeners = [];
  const window = {
    addEventListener: (type, fn) => type === "message" && listeners.push(fn),
    removeEventListener: (_type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage(data) {
      setImmediate(() => {
        for (const fn of [...listeners]) fn({ source: window, data });
      });
    },
    require(name) {
      if (name !== "WAWebCollections") throw new Error(`no module ${name}`);
      const models = Object.entries(fixture.newsletters || {}).map(([id, msgs]) => ({
        id: { _serialized: id },
        msgs: { _models: msgs },
      }));
      return {
        WAWebNewsletterCollection: {
          get: (id) => models.find((m) => m.id._serialized === id),
          getModelsArray: () => models,
        },
      };
    },
  };

  const document = {
    documentElement: { lang, dataset: {} },
    body: {},
    querySelector: (selector) => fixture.dom?.[selector] ?? null,
  };

  const onMessage = [];
  const sent = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => onMessage.push(fn) },
      sendMessage: async (msg) => {
        sent.push(msg);
        return reply(msg);
      },
      getManifest: () => ({ version, name: "test" }),
    },
    i18n: { getMessage: (key) => key },
  };

  const timers = [];
  const globals = {
    window,
    document,
    navigator: { language: lang },
    indexedDB: fakeIndexedDB(fixture.stores || {}),
    chrome,
    FileReader: FakeFileReader,
    MutationObserver: class {
      observe() {}
    },
    // the schedule (first run after 10 s, every 2 and 15 min) never fires in tests
    setTimeout: (fn, ms) => (ms >= 10_000 ? (timers.push({ fn, ms }), 0) : setTimeout(fn, ms)),
    setInterval: (fn, ms) => (timers.push({ fn, ms, repeat: true }), 0),
    clearTimeout: (id) => id && clearTimeout(id),
    fetch: async (url) => {
      throw new Error(`no network in tests (${url})`);
    },
  };

  return {
    sent,
    timers,
    /** Runs a classic script file as if the browser had injected it. */
    load(path) {
      const source = readFileSync(path, "utf8");
      new Function(...Object.keys(globals), source)(...Object.values(globals));
    },
    /** Sends a message to the content scripts (like chrome.tabs.sendMessage) and waits for the answer. */
    message(msg) {
      return new Promise((resolve, reject) => {
        for (const fn of onMessage) if (fn(msg, {}, resolve) === true) return;
        reject(new Error(`no listener answered ${JSON.stringify(msg)}`));
      });
    },
  };
}
