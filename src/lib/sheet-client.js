"use client";

/**
 * Browser-side sheet reading for the chunked upload.
 *
 * The 20MB workbook never leaves the browser: it is parsed here, de-duplicated,
 * and streamed as small JSON batches. Only ~0.7MB crosses the wire at a time,
 * which keeps every request under the 4.5MB body limit and short enough not to
 * hit the function timeout.
 *
 * This does NOT validate. The server re-parses every row it receives, because
 * nothing the browser sends can be trusted.
 */

// 2,500 rows meant roughly 6,000 individual writes per request — about 5.8s
// against a nearby database, and past the 60s function limit from a distant
// one. Smaller batches trade more requests for headroom against that ceiling.
export const CHUNK_ROWS = 1000;

const norm = (h) => String(h ?? "").trim().toUpperCase();

/**
 * Reads the sheet in one pass: parse, de-duplicate and collect dates together.
 *
 * The earlier version held three copies at once — the workbook, the raw rows,
 * and a de-duplicated array — then walked the rows again for dates. On a large
 * sales sheet that was enough to crash the browser tab, which reports only
 * "This page couldn't load" with no clue as to why.
 *
 * Here the workbook is released as soon as rows are extracted, and raw rows are
 * consumed into the de-duplicated map as they are read, so only one full copy
 * is ever alive.
 */
export async function readSheet(file, fileType, snapshotDate, metaHeaders) {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();

  // dense stores cells in arrays rather than an object per cell, and the
  // disabled options stop styles and number formats being materialised — none
  // of which this app reads.
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
  // Released before the heavy work below, so the workbook is not alive
  // alongside the de-duplicated rows.
  workbook = null;
  if (!raw.length) throw new Error("The sheet has no rows.");

  const headers = Object.keys(raw[0]);
  const branchColumns = detectBranchColumns(headers, metaHeaders);
  const dates = new Set();
  const out = new Map();

  // Consumed from the end so the source array shrinks as the map grows, rather
  // than both being fully resident.
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i];
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

  return {
    headers,
    branchColumns,
    rows: [...out.values()],
    dates: [...dates].sort(),
    duplicatesMerged: raw.length - out.size,
    totalRows: raw.length,
  };
}

/** yyyy-mm-dd from a sheet's MONTH / DAY pair, or null. */
function isoDate(rawMonth, rawDay) {
  const months = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const m = String(rawMonth ?? "").trim().toUpperCase().match(/([A-Z]{3})[A-Z]*-?(\d{2,4})?/);
  const day = parseInt(String(rawDay ?? "").replace(/[^0-9]/g, ""), 10);
  if (!m || !(m[1] in months) || !Number.isFinite(day)) return null;
  const year = m[2] ? (m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])) : new Date().getUTCFullYear();
  const d = new Date(Date.UTC(year, months[m[1]], day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A stable fingerprint of the file, so a re-upload can be recognised. */
export async function fingerprint(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}



/** Which columns are branches: everything that is not a known meta column. */
export function detectBranchColumns(headers, metaHeaders) {
  const meta = new Set(metaHeaders.map(norm));
  return headers.map(norm).filter((h) => h && !meta.has(h));
}
