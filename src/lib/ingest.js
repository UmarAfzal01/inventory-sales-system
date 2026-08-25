import {
  BRANCH_CODES,
  ALL_META_HEADERS,
  REQUIRED_HEADERS,
  META_COLUMNS,
  JUNK_VALUES,
  UNCATEGORIZED,
} from "@/lib/schema";

/** Trimmed uppercase, the form every header is compared in. */
export const normHeader = (h) => String(h ?? "").trim().toUpperCase();

/**
 * Uploads above this are refused before parsing.
 *
 * The guard is against exhausting memory, not a business rule — the whole file
 * is buffered and then expanded into row objects. Set well above any real sheet:
 * a 211k-row inventory export sits comfortably under this, and an uncompressed
 * conversion of the same data reached 130MB, so the ceiling has to allow for
 * badly-saved but genuine files.
 */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

const EXTENSIONS = [".xlsx", ".xlsm", ".xls", ".csv"];

/**
 * Signatures for the formats we accept, plus common things people upload by
 * mistake. Extension alone proves nothing — renaming a PDF to .xlsx passes any
 * name check and then dies inside the parser with an unreadable stack trace.
 */
const SIGNATURES = [
  { magic: [0x50, 0x4b, 0x03, 0x04], kind: "zip" },   // xlsx/xlsm (and .zip, .docx…)
  { magic: [0x50, 0x4b, 0x05, 0x06], kind: "zip" },   // empty archive
  { magic: [0x50, 0x4b, 0x07, 0x08], kind: "zip" },   // spanned archive
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], kind: "ole2" }, // legacy .xls
  { magic: [0x25, 0x50, 0x44, 0x46], kind: "PDF" },
  { magic: [0x89, 0x50, 0x4e, 0x47], kind: "PNG image" },
  { magic: [0xff, 0xd8, 0xff], kind: "JPEG image" },
  { magic: [0x47, 0x49, 0x46, 0x38], kind: "GIF image" },
  { magic: [0x1f, 0x8b], kind: "gzip archive" },
  { magic: [0x52, 0x61, 0x72, 0x21], kind: "RAR archive" },
  { magic: [0x37, 0x7a, 0xbc, 0xaf], kind: "7z archive" },
];

const startsWith = (buf, magic) =>
  buf.length >= magic.length && magic.every((b, i) => buf[i] === b);

/**
 * Validates the uploaded file itself, before any parsing.
 *
 * Returns { ok, errors }. Everything here is checked server-side: the browser's
 * `accept` attribute and the client-side name check are conveniences, not
 * controls — anything posting directly to this endpoint bypasses both.
 */
export function validateFile({ name, size, buffer }) {
  const errors = [];
  const filename = String(name ?? "").trim();
  const lower = filename.toLowerCase();
  const ext = EXTENSIONS.find((e) => lower.endsWith(e));

  if (!size || size === 0 || !buffer?.length) {
    errors.push("The file is empty.");
    return { ok: false, errors };
  }

  if (size > MAX_UPLOAD_BYTES) {
    errors.push(
      `The file is ${(size / 1048576).toFixed(1)}MB. The limit is ` +
        `${MAX_UPLOAD_BYTES / 1048576}MB — split it into smaller sheets.`
    );
    return { ok: false, errors };
  }

  if (!ext) {
    errors.push(
      `"${filename || "This file"}" is not a spreadsheet. ` +
        `Accepted types are ${EXTENSIONS.join(", ")}.`
    );
    return { ok: false, errors };
  }

  const found = SIGNATURES.find((s) => startsWith(buffer, s.magic));

  if (ext === ".xlsx" || ext === ".xlsm") {
    if (found?.kind !== "zip") {
      errors.push(
        found && found.kind !== "ole2"
          ? `This is a ${found.kind}, renamed to ${ext}. Save it as a real Excel file.`
          : found?.kind === "ole2"
            ? `This is an old-format .xls saved with an ${ext} name. Rename it to .xls, or re-save as .xlsx.`
            : `This is not a valid ${ext} file — its contents do not match the format.`
      );
    }
  } else if (ext === ".xls") {
    if (found?.kind !== "ole2") {
      errors.push(
        found?.kind === "zip"
          ? "This is a modern .xlsx saved with an .xls name. Rename it to .xlsx."
          : found
            ? `This is a ${found.kind}, renamed to .xls. Save it as a real Excel file.`
            : "This is not a valid .xls file — its contents do not match the format."
      );
    }
  } else if (ext === ".csv") {
    // CSV has no signature, so only rule out obviously binary content.
    if (found && found.kind !== "zip" && found.kind !== "ole2") {
      errors.push(`This is a ${found.kind}, renamed to .csv. Export it as CSV text instead.`);
    } else if (buffer.subarray(0, 8000).includes(0)) {
      errors.push("This .csv contains binary data — it is not a text file.");
    }
  }

  return { ok: errors.length === 0, errors };
}

const clean = (v) => {
  const s = String(v ?? "").trim();
  return JUNK_VALUES.has(s.toUpperCase()) ? "" : s;
};

/**
 * Barcodes must survive as exact strings.
 *
 * Excel stores long digit-strings as numbers, and any formatted read turns
 * 633152000000 into "6.33152E+11" — which not only mangles the barcode but
 * collapses DIFFERENT products onto the same value. Reading raw gives the
 * underlying number, which `toFixed(0)` renders without an exponent.
 *
 * Text-typed cells (the ones with leading zeros) come through untouched.
 */
export function normaliseBarcode(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  return String(v).trim();
}

/** True when a value already arrived mangled into exponent form. */
export const looksExponential = (v) => /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(String(v ?? "").trim());

const pick = (row, names) => {
  for (const n of names) if (row[n] !== undefined) return row[n];
  return undefined;
};

export const MONTH_ABBR = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** UTC midnight, so one calendar day is exactly one value. */
export const utcDay = (y, m, d) => new Date(Date.UTC(y, m, d));

export const dateSlug = (date) => date.toISOString().slice(0, 10);

/**
 * Parses the sales sheet's date columns: MONTH "AUG-26" + DAY "19".
 * Returns null when the row cannot be dated — callers must not invent a default,
 * because a wrongly dated row silently corrupts every range it lands in.
 */
export function parseSheetDate(month, day) {
  const m = normHeader(month);
  const d = parseInt(String(day ?? "").replace(/^DAY/i, "").trim(), 10);
  if (!m || !Number.isFinite(d) || d < 1 || d > 31) return null;

  const abbr = m.split("-")[0].trim();
  if (!(abbr in MONTH_ABBR)) return null;

  const suffix = m.includes("-") ? m.split("-").pop().trim() : "";
  let year = suffix.length === 2 ? 2000 + parseInt(suffix, 10) : parseInt(suffix, 10);
  if (!Number.isFinite(year)) return null;

  const date = utcDay(year, MONTH_ABBR[abbr], d);
  // Rejects impossible dates like 31 Feb, which JS would roll into March.
  return date.getUTCDate() === d ? date : null;
}

/** Parses an ISO yyyy-mm-dd from the inventory date picker. */
export function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const date = utcDay(y, mo - 1, d);
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * Validates sheet headers against the declared schema BEFORE anything is read.
 *
 * Unknown columns are rejected rather than treated as branches. The previous
 * rule — "any header not in a hardcoded list is a branch" — meant a typo or an
 * extra column became a branch full of fabricated quantities.
 */
export function validateHeaders(rawHeaders, fileType) {
  const headers = rawHeaders.map(normHeader).filter(Boolean);
  const errors = [];
  const warnings = [];

  const seen = new Set();
  const duplicates = new Set();
  for (const h of headers) {
    if (seen.has(h)) duplicates.add(h);
    seen.add(h);
  }
  if (duplicates.size) errors.push(`Duplicate columns: ${[...duplicates].join(", ")}`);

  const known = new Set([...ALL_META_HEADERS, ...BRANCH_CODES]);
  const unknown = headers.filter((h) => !known.has(h));
  if (unknown.length) {
    errors.push(
      `Unrecognised column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Expected branches are ${BRANCH_CODES.join(", ")}. ` +
        `Rename the column or add the branch to the registry.`
    );
  }

  for (const req of REQUIRED_HEADERS[fileType] ?? []) {
    if (!seen.has(req)) errors.push(`Missing required column: ${req}`);
  }

  const branchColumns = headers.filter((h) => BRANCH_CODES.includes(h));
  if (!branchColumns.length) errors.push("No branch columns found.");

  const missingBranches = BRANCH_CODES.filter((b) => !seen.has(b));
  if (missingBranches.length) {
    warnings.push(
      `No column for: ${missingBranches.join(", ")}. Those branches get no data from this file.`
    );
  }

  if (fileType === "inventory" && (seen.has("MONTH") || seen.has("DAY"))) {
    warnings.push("This inventory sheet has MONTH/DAY columns; the snapshot date you pick is used instead.");
  }

  return { ok: errors.length === 0, errors, warnings, headers, branchColumns };
}

/**
 * Normalises one sheet row into a typed record.
 *
 * `snapshotDate` supplies the date for inventory sheets, which carry no date
 * columns at all — that is why every inventory upload previously landed on the
 * same fabricated day.
 */
export function parseRow(row, { fileType, branchColumns, snapshotDate }) {
  const rawBarcode = pick(row, META_COLUMNS.BARCODE);
  const barcode = normaliseBarcode(rawBarcode);
  if (!barcode) return { skip: "no-barcode" };
  // An exponent here means the value was already mangled before we saw it, so
  // the true barcode is unrecoverable. Better to reject than to store a wrong
  // one that silently merges two products.
  if (looksExponential(rawBarcode)) return { skip: "bad-barcode" };

  const date =
    fileType === "sale"
      ? parseSheetDate(pick(row, META_COLUMNS.MONTH), pick(row, META_COLUMNS.DAY))
      : snapshotDate;
  if (!date) return { skip: "no-date" };

  const num = (v) => {
    const n = Number(clean(v));
    return Number.isFinite(n) ? n : null;
  };

  const cells = [];
  for (const branch of branchColumns) {
    const raw = row[branch];
    // Blank means the sheet recorded nothing. Never coerce it to zero.
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const qty = Number(String(raw).trim());
    if (!Number.isFinite(qty)) continue;
    cells.push({ branch, qty });
  }

  return {
    barcode,
    date,
    product: {
      articleName: clean(pick(row, META_COLUMNS.ARTICLE_NAME)) || "Unknown",
      category: clean(pick(row, META_COLUMNS.CATEGORY)) || UNCATEGORIZED,
      subCategory: clean(pick(row, META_COLUMNS.SUB_CATEGORY)),
      type: clean(pick(row, META_COLUMNS.TYPE)),
      sellingStatus: clean(pick(row, META_COLUMNS.SELLING_STATUS)),
      saleRate: num(pick(row, META_COLUMNS.SALE_RATE)),
      costPrice: num(pick(row, META_COLUMNS.COST_PRICE)),
    },
    cells,
  };
}
