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

/** Reads the first sheet and returns its headers and raw rows. */
export async function readWorkbook(file) {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  // raw:true returns underlying cell values. Formatted reads render long
  // barcodes as "6.33152E+11", which corrupts them and can merge two products.
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The workbook has no sheets.");

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  if (!rows.length) throw new Error("The sheet has no rows.");
  return { headers: Object.keys(rows[0]), rows };
}

/** A stable fingerprint of the file, so a re-upload can be recognised. */
export async function fingerprint(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Collapses rows that share a natural key.
 *
 * This is what makes the batches safe to write with $inc and safe to retry: a
 * key must appear in exactly one batch, or the stock cube counts it twice.
 * Inventory keys on barcode alone — a repeated line is a later reading, last
 * one wins. Sales key on barcode and day, and the branch quantities are summed,
 * matching what the single-request path does in memory.
 */
export function dedupeRows(rows, fileType, branchColumns) {
  const out = new Map();
  for (const row of rows) {
    const keyed = {};
    for (const k of Object.keys(row)) keyed[norm(k)] = row[k];
    const barcode = String(keyed.BARCODE ?? "").trim();
    if (!barcode) continue;

    const key =
      fileType === "inventory"
        ? barcode
        : `${barcode}|${keyed.MONTH ?? ""}|${keyed.DAY ?? ""}`;

    const existing = out.get(key);
    if (!existing) {
      out.set(key, row);
      continue;
    }
    if (fileType === "inventory") {
      out.set(key, row); // last reading wins
    } else {
      // Same product, same day, listed twice: the quantities add up.
      const merged = { ...existing };
      for (const branch of branchColumns) {
        const a = Number(existing[branch] ?? 0) || 0;
        const b = Number(row[branch] ?? 0) || 0;
        if (a || b) merged[branch] = a + b;
      }
      out.set(key, merged);
    }
  }
  return [...out.values()];
}

/** The distinct dates a sales sheet covers, as yyyy-mm-dd. */
export function datesInRows(rows, fileType, snapshotDate) {
  if (fileType === "inventory") return snapshotDate ? [snapshotDate] : [];
  const months = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const seen = new Set();
  for (const row of rows) {
    const keyed = {};
    for (const k of Object.keys(row)) keyed[norm(k)] = row[k];
    const rawMonth = String(keyed.MONTH ?? "").trim().toUpperCase();
    const day = parseInt(String(keyed.DAY ?? "").replace(/[^0-9]/g, ""), 10);
    const m = rawMonth.match(/([A-Z]{3})[A-Z]*-?(\d{2,4})?/);
    if (!m || !(m[1] in months) || !Number.isFinite(day)) continue;
    const year = m[2] ? (m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])) : new Date().getUTCFullYear();
    const d = new Date(Date.UTC(year, months[m[1]], day));
    if (!Number.isNaN(d.getTime())) seen.add(d.toISOString().slice(0, 10));
  }
  return [...seen].sort();
}

/** Which columns are branches: everything that is not a known meta column. */
export function detectBranchColumns(headers, metaHeaders) {
  const meta = new Set(metaHeaders.map(norm));
  return headers.map(norm).filter((h) => h && !meta.has(h));
}
