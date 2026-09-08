"use client";

/**
 * Main-thread side of the worker-based sheet reader.
 *
 * Wraps the message passing in promises so the upload code reads sequentially.
 * The worker owns the parsed rows for its lifetime; call `close()` when the
 * upload finishes or fails, or its heap is held until the page navigates.
 */

export const CHUNK_ROWS = 1000;

export function openSheetReader() {
  const worker = new Worker(new URL("./sheet-worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let nextId = 0;
  let onFatal = null;

  worker.onmessage = (event) => {
    const msg = event.data;
    // Parse results and chunk results are keyed differently: there is only ever
    // one parse in flight, while chunks are requested by sequence number.
    const key = msg.type === "chunk" ? `chunk:${msg.seq}` : "parse";
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    if (msg.type === "error") entry.reject(new Error(msg.message));
    else entry.resolve(msg);
  };

  // A worker that dies — almost always out of memory on a very large sheet —
  // would otherwise leave every pending promise hanging for ever.
  worker.onerror = (e) => {
    const err = new Error(
      e?.message ||
        "The sheet could not be read — it may be too large for this browser to parse."
    );
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
    if (onFatal) onFatal(err);
  };

  const send = (key, message) =>
    new Promise((resolve, reject) => {
      pending.set(key, { resolve, reject });
      worker.postMessage(message);
    });

  return {
    parse: ({ file, fileType, snapshotDate, metaHeaders }) =>
      send("parse", { type: "parse", file, fileType, snapshotDate, metaHeaders }),

    chunk: (seq, from, size) => {
      nextId += 1;
      return send(`chunk:${seq}`, { type: "chunk", seq, from, size }).then((m) => m.rows);
    },

    onFatalError: (fn) => {
      onFatal = fn;
    },

    close: () => {
      pending.clear();
      worker.terminate();
    },
  };
}

/** A stable fingerprint of the file, so a re-upload can be recognised. */
export async function fingerprint(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
