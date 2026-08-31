import { NextResponse } from "next/server";
import crypto from "crypto";
import * as XLSX from "xlsx";
import { Readable } from "stream";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL, ensureSchema } from "@/lib/schema";
import { validateFile, validateHeaders, parseRow, parseIsoDate, normHeader, dateSlug } from "@/lib/ingest";
import { commit, rebuildMeta, compactIndexes } from "@/lib/warehouse";
import { requireUser } from "@/lib/guard";

// SheetJS's streaming reader needs Node's Readable handed to it explicitly.
// Under Next's bundler it is not auto-detected, and to_json fails with
// "_Readable is not a function".
XLSX.stream.set_readable(Readable);

export const runtime = "nodejs";
// Parsing a 23MB sheet, writing the facts and rebuilding the cubes all happen
// before this responds. Serverless platforms read this from the build output.
export const maxDuration = 300;

export async function POST(req) {
  try {
    // Uploading rewrites the warehouse, so it is admin-only. Checked here and
    // not only in middleware, which does not run for every path an API route
    // can be reached by.
    const { user, error: authError } = await requireUser(req, { admin: true });
    if (authError) return authError;

    await dbConnect();
    const database = mongoose.connection.db;
    // Forced here, unlike on the read path: an upload is rare and slow enough
    // that re-checking is free, and it is the one moment worth paying to
    // rebuild indexes dropped by hand or lost when the cluster was cleared.
    await ensureSchema(database, { force: true });

    const form = await req.formData();
    const file = form.get("file");
    const fileType = form.get("fileType") === "inventory" ? "inventory" : "sale";
    const action = form.get("action") === "upload" ? "upload" : "preview";
    const snapshotDateRaw = form.get("snapshotDate");

    if (!file) {
      return NextResponse.json({ success: false, error: "No file provided." }, { status: 400 });
    }

    // Inventory sheets carry no date columns, so the snapshot date must come
    // from the operator. Defaulting it — which is what used to happen — filed
    // every snapshot under the same fabricated day.
    let snapshotDate = null;
    if (fileType === "inventory") {
      snapshotDate = parseIsoDate(snapshotDateRaw);
      if (!snapshotDate) {
        return NextResponse.json(
          { success: false, error: "Pick a snapshot date for this inventory sheet (yyyy-mm-dd)." },
          { status: 400 }
        );
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Check the file really is a spreadsheet before handing it to the parser.
    // The browser's accept attribute and the client-side name check are
    // conveniences; anything posting here directly bypasses both.
    const fileCheck = validateFile({ name: file.name, size: buffer.length, buffer });
    if (!fileCheck.ok) {
      return NextResponse.json(
        { success: false, stage: "file", errors: fileCheck.errors },
        { status: 400 }
      );
    }

    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    } catch (err) {
      // Corrupt or password-protected files reach here despite a valid signature.
      return NextResponse.json(
        {
          success: false,
          stage: "file",
          errors: [`This file could not be opened — it may be corrupted or password protected. (${err.message})`],
        },
        { status: 400 }
      );
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      return NextResponse.json({ success: false, error: "The workbook has no sheets." }, { status: 400 });
    }

    // `raw: true` returns underlying cell values rather than their display
    // format. Formatted reads render long barcodes as "6.33152E+11", which
    // corrupts them and can merge two products onto one id. Text-typed cells
    // (the ones with leading zeros) are unaffected either way.
    //
    // Headers come from a one-row read so the whole sheet is not materialised
    // just to validate them.
    const headerRow = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true, range: 0 })[0];
    if (!headerRow) {
      return NextResponse.json({ success: false, error: "The sheet has no rows." }, { status: 400 });
    }

    const headerCheck = validateHeaders(Object.keys(headerRow), fileType);
    if (!headerCheck.ok) {
      return NextResponse.json(
        { success: false, stage: "headers", errors: headerCheck.errors, warnings: headerCheck.warnings },
        { status: 400 }
      );
    }

    const rows = [];
    const skipped = { noBarcode: 0, noDate: 0, badBarcode: 0 };
    const dateSet = new Map();
    let totalRows = 0;

    // Streamed rather than read into an array first.
    //
    // A 493k-row sales sheet previously held three copies at once — the parsed
    // workbook, the full sheet_to_json array, and the parsed `rows` — and
    // exhausted Node's heap. Streaming drops one of those, and each raw row is
    // discarded as soon as it has been parsed.
    await new Promise((resolve, reject) => {
      const stream = XLSX.stream.to_json(sheet, { defval: "", raw: true });
      stream.on("data", (raw) => {
        totalRows++;
        const row = {};
        for (const k of Object.keys(raw)) row[normHeader(k)] = raw[k];

        const parsed = parseRow(row, {
          fileType,
          branchColumns: headerCheck.branchColumns,
          snapshotDate,
        });
        if (parsed.skip === "no-barcode") { skipped.noBarcode++; return; }
        if (parsed.skip === "bad-barcode") { skipped.badBarcode++; return; }
        if (parsed.skip === "no-date") { skipped.noDate++; return; }

        dateSet.set(parsed.date.getTime(), parsed.date);
        rows.push(parsed);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });

    if (!totalRows) {
      return NextResponse.json({ success: false, error: "The sheet has no rows." }, { status: 400 });
    }

    const dates = [...dateSet.values()].sort((a, b) => a - b);
    const warnings = [...headerCheck.warnings];
    if (skipped.noBarcode) warnings.push(`${skipped.noBarcode} row(s) skipped — no barcode.`);
    if (skipped.noDate) warnings.push(`${skipped.noDate} row(s) skipped — unreadable MONTH/DAY.`);
    if (skipped.badBarcode) {
      warnings.push(
        `${skipped.badBarcode} row(s) skipped — the barcode arrived in scientific notation ` +
          `(e.g. 6.33E+11) and cannot be recovered. Format the BARCODE column as Text in Excel and re-export.`
      );
    }

    const summary = {
      fileType,
      totalRows,
      usableRows: rows.length,
      branchColumns: headerCheck.branchColumns,
      dates: dates.map(dateSlug),
      cells: rows.reduce((n, r) => n + r.cells.length, 0),
      skipped,
      warnings,
    };

    if (action === "preview") {
      const already = await database
        .collection(COL.BATCHES)
        .findOne({ fileHash, status: "committed" });
      return NextResponse.json({
        success: true,
        isPreview: true,
        summary: {
          ...summary,
          alreadyUploaded: already
            ? { at: already.uploadedAt, name: already.fileName }
            : null,
        },
      });
    }

    if (!rows.length) {
      return NextResponse.json(
        { success: false, error: "No usable rows.", summary },
        { status: 400 }
      );
    }

    const committed = await database
      .collection(COL.BATCHES)
      .findOne({ fileHash, status: "committed" });
    if (committed) {
      return NextResponse.json(
        {
          success: false,
          error: `This exact file was already uploaded on ${committed.uploadedAt.toISOString().slice(0, 10)}.`,
        },
        { status: 409 }
      );
    }

    // Claiming the running slot IS the lock — a partial unique index permits
    // only one batch with status "running", so a second concurrent upload fails
    // on insert rather than racing past a check.
    const STALE_AFTER_MS = 30 * 60 * 1000;
    const batchId = new mongoose.Types.ObjectId();
    const claim = async () =>
      database.collection(COL.BATCHES).insertOne({
      _id: batchId,
      fileHash,
      fileName: file.name ?? "upload.xlsx",
      fileSize: buffer.length,
      fileType,
      uploadedBy: user.email,
      dates,
      totalRows,
      usableRows: rows.length,
      skipped,
      warnings,
      status: "running",
      uploadedAt: new Date(),
    });

    try {
      await claim();
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Someone holds the slot. Release it only if it is clearly abandoned;
      // otherwise tell the caller to wait.
      const holder = await database.collection(COL.BATCHES).findOne({ status: "running" });
      const age = holder ? Date.now() - holder.uploadedAt.getTime() : Infinity;
      if (holder && age < STALE_AFTER_MS) {
        return NextResponse.json(
          {
            success: false,
            error:
              `Another upload is still running (${holder.fileName}, started ` +
              `${Math.max(1, Math.round(age / 60000))} minute(s) ago). Wait for it to finish.`,
          },
          { status: 409 }
        );
      }
      if (holder) {
        await database
          .collection(COL.BATCHES)
          .updateOne({ _id: holder._id }, { $set: { status: "abandoned" } });
      }
      await claim();
    }

    try {
      const result = await commit({ rows, fileType, batchId, dates });
      await rebuildMeta();

      // commit() drops the secondary indexes on the collections it bulk-loads
      // and rebuilds them at the end, so those come back compact on their own.
      // `products` is upserted outside that window, so it still bloats slowly.
      const reclaimed = await compactIndexes(database, [COL.PRODUCTS]);
      await database
        .collection(COL.BATCHES)
        .updateOne(
          { _id: batchId },
          { $set: { status: "committed", indexBytesReclaimed: reclaimed, ...result } }
        );

      // A back-dated inventory sheet is recorded as history but deliberately
      // does not become the current stock position. Say so plainly rather than
      // reporting a plain success that hides it.
      const backDated =
        fileType === "inventory" && result.currentPositionUpdated === false;

      const message = backDated
        ? `Loaded ${rows.length.toLocaleString()} rows for ${dates.map(dateSlug).join(", ")} as historical data. ` +
          `Current stock still shows the newer count from ${result.heldAsOf}.`
        : `Loaded ${rows.length.toLocaleString()} rows of ${fileType} data ` +
          `for ${dates.map(dateSlug).join(", ")}.`;

      return NextResponse.json({
        success: true,
        message,
        backDated,
        heldAsOf: result.heldAsOf ?? null,
        batchId,
        summary,
      });
    } catch (err) {
      await database
        .collection(COL.BATCHES)
        .updateOne({ _id: batchId }, { $set: { status: "failed", error: err.message } });
      throw err;
    }
  } catch (error) {
    console.error("Upload error:", error);
    // A duplicate fileHash means this exact file was already ingested.
    if (error.code === 11000 && String(error.message).includes("fileHash")) {
      return NextResponse.json(
        { success: false, error: "This exact file has already been uploaded." },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
