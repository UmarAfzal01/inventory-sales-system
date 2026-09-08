/**
 * Parses the workbook in a Web Worker, and keeps the rows there.
 *
 * Parsing a 14MB sheet costs ~340MB transiently, whatever is done afterwards:
 * XLSX.read has to build the whole workbook before a single row can be read.
 * On the main thread, on top of a dashboard already holding data, that is
 * enough to kill the tab — and a dead renderer reports only "This page
 * couldn't load", so nothing in the app can explain it.
 *
 * In a worker that memory is confined to a separate heap. If it does run out,
 * the worker dies rather than the page, and the failure can be reported.
 *
 * Rows are NOT posted back in one go — that would rebuild the same problem on
 * the main thread. The worker holds them and hands over one batch at a time,
 * so the page only ever holds the batch it is currently uploading.
 */

const norm = (h) => String(h ?? "").trim().toUpperCase();

/** yyyy-mm-dd from a sheet's MONTH / DAY pair, or null. */
function isoDate(rawMonth, rawDay) {
  const months = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const m = String(rawMonth ?? "").trim().toUpperCase().match(/([A-Z]{3})[A-Z]*-?(\d{2,4})?/);
  const day = parseInt(String(rawDay ?? "").replace(/[^0-9]/g, ""), 10);
  if (!m || !(m[1] in months) || !Number.isFinite(day)) return null;
  const year = m[2]
    ? m[2].length === 2
      ? 2000 + Number(m[2])
      : Number(m[2])
    : new Date().getUTCFullYear();
  const d = new Date(Date.UTC(year, months[m[1]], day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

let rows = [];

self.onmessage = async (event) => {
  const msg = event.data;

  // Hand back one batch. The main thread asks for these as it uploads, so it
  // never holds more than a batch at a time.
  if (msg.type === "chunk") {
    const { from, size } = msg;
    self.postMessage({ type: "chunk", seq: msg.seq, rows: rows.slice(from, from + size) });
    return;
  }

  if (msg.type !== "parse") return;

  try {
    const { file, fileType, snapshotDate, metaHeaders } = msg;
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();

    // dense stores cells in arrays rather than an object per cell; styles,
    // number formats and HTML are switched off because nothing reads them.
    let workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: false,
      dense: true,
      cellStyles: false,
      cellNF: false,
      cellHTML: false,
      sheetStubs: false,
    });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("The workbook has no sheets.");

    // raw:true returns underlying cell values. Formatted reads render long
    // barcodes as "6.33152E+11", which corrupts them and can merge two products.
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
    workbook = null;
    if (!raw.length) throw new Error("The sheet has no rows.");

    const headers = Object.keys(raw[0]);
    const meta = new Set(metaHeaders.map(norm));
    const branchColumns = headers.map(norm).filter((h) => h && !meta.has(h));

    const dates = new Set();
    const out = new Map();

    for (let i = 0; i < raw.length; i += 1) {
      const row = raw[i];
      // Released as it is consumed, so the source array shrinks while the map
      // grows rather than both being fully resident.
      raw[i] = null;

      const keyed = {};
      for (const k of Object.keys(row)) keyed[norm(k)] = row[k];
      const barcode = String(keyed.BARCODE ?? "").trim();
      if (!barcode) continue;

      if (fileType === "inventory") {
        if (snapshotDate) dates.add(snapshotDate);
        // A repeated line is a later reading of the same product: last wins.
        out.set(barcode, row);
        continue;
      }

      const day = isoDate(keyed.MONTH, keyed.DAY);
      if (!day) continue;
      dates.add(day);

      const key = `${barcode}|${day}`;
      const existing = out.get(key);
      if (!existing) {
        out.set(key, row);
        continue;
      }
      // Same product, same day, listed twice: the quantities add up.
      for (const branch of branchColumns) {
        const a = Number(existing[branch] ?? 0) || 0;
        const b = Number(row[branch] ?? 0) || 0;
        if (a || b) existing[branch] = a + b;
      }
    }

    const totalRows = raw.length;
    rows = [...out.values()];
    out.clear();

    self.postMessage({
      type: "parsed",
      headers,
      branchColumns,
      dates: [...dates].sort(),
      totalRows,
      usableRows: rows.length,
      duplicatesMerged: totalRows - rows.length,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || "Could not read this file." });
  }
};
