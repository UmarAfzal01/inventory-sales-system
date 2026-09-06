import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL } from "@/lib/schema";
import { parseRow, normHeader } from "@/lib/ingest";
import { requireUser } from "@/lib/guard";
import { writeChunk } from "@/lib/warehouse";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Phase 2: one batch of rows.
 *
 * Rows arrive as the raw objects the sheet produced, and are put through the
 * SAME parseRow the single-request path uses. That is the point: the browser
 * is untrusted, so barcode normalisation, scientific-notation rejection and
 * date parsing all have to happen here, not there.
 */
export async function POST(req) {
  try {
    const { error } = await requireUser(req, { admin: true });
    if (error) return error;

    await dbConnect();
    const database = mongoose.connection.db;

    const body = await req.json().catch(() => ({}));
    const seq = Number(body.seq);
    if (!body.batchId || !Number.isInteger(seq)) {
      return NextResponse.json({ success: false, error: "Malformed batch request." }, { status: 400 });
    }

    let _id;
    try {
      _id = new mongoose.Types.ObjectId(String(body.batchId));
    } catch {
      return NextResponse.json({ success: false, error: "Unknown batch." }, { status: 404 });
    }

    const batch = await database.collection(COL.BATCHES).findOne({ _id });
    if (!batch) {
      return NextResponse.json({ success: false, error: "Unknown batch." }, { status: 404 });
    }
    if (batch.status !== "running") {
      return NextResponse.json(
        { success: false, error: `This upload is already ${batch.status}.` },
        { status: 409 }
      );
    }

    // A retried batch is applied again rather than skipped: every write is
    // keyed on a natural id, so replaying it is a no-op, whereas skipping a
    // batch that only *looked* applied would silently lose rows.
    const raws = Array.isArray(body.rows) ? body.rows : [];
    const snapshotDate = batch.fileType === "inventory" ? batch.dates[0] : null;

    const rows = [];
    const skipped = { noBarcode: 0, noDate: 0, badBarcode: 0 };
    for (const raw of raws) {
      const row = {};
      for (const k of Object.keys(raw)) row[normHeader(k)] = raw[k];
      const parsed = parseRow(row, {
        fileType: batch.fileType,
        branchColumns: batch.branchColumns,
        snapshotDate,
      });
      if (parsed.skip === "no-barcode") { skipped.noBarcode++; continue; }
      if (parsed.skip === "bad-barcode") { skipped.badBarcode++; continue; }
      if (parsed.skip === "no-date") { skipped.noDate++; continue; }
      rows.push(parsed);
    }

    const result = rows.length
      ? await writeChunk({
          database,
          rows,
          fileType: batch.fileType,
          batchId: _id,
          dates: batch.dates,
          isNewer: batch.isNewer,
          branchColumns: batch.branchColumns,
        })
      : { rows: 0, written: 0 };

    await database.collection(COL.BATCHES).updateOne(
      { _id },
      {
        $inc: {
          receivedRows: rows.length,
          "skipped.noBarcode": skipped.noBarcode,
          "skipped.noDate": skipped.noDate,
          "skipped.badBarcode": skipped.badBarcode,
        },
        $addToSet: { appliedSeq: seq },
      }
    );

    return NextResponse.json({ success: true, seq, accepted: rows.length, skipped, ...result });
  } catch (error) {
    console.error("Upload chunk error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
