import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL } from "@/lib/schema";
import { dateSlug } from "@/lib/ingest";
import { requireUser } from "@/lib/guard";
import { finishBatch, compactIndexes } from "@/lib/warehouse";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Phase 3: aggregates, indexes, and the batch marked done. */
export async function POST(req) {
  try {
    const { error } = await requireUser(req, { admin: true });
    if (error) return error;

    await dbConnect();
    const database = mongoose.connection.db;

    const { batchId } = await req.json().catch(() => ({}));
    let _id;
    try {
      _id = new mongoose.Types.ObjectId(String(batchId));
    } catch {
      return NextResponse.json({ success: false, error: "Unknown batch." }, { status: 404 });
    }

    const batch = await database.collection(COL.BATCHES).findOne({ _id });
    if (!batch) return NextResponse.json({ success: false, error: "Unknown batch." }, { status: 404 });
    if (batch.status !== "running") {
      return NextResponse.json(
        { success: false, error: `This upload is already ${batch.status}.` },
        { status: 409 }
      );
    }

    await finishBatch({
      database,
      fileType: batch.fileType,
      dates: batch.dates,
      batchId: _id,
    });
    // products is upserted outside the index window, so it still bloats slowly.
    const reclaimed = await compactIndexes(database, [COL.PRODUCTS]);

    await database
      .collection(COL.BATCHES)
      .updateOne({ _id }, { $set: { status: "committed", committedAt: new Date(), indexBytesReclaimed: reclaimed } });

    const backDated = batch.fileType === "inventory" && batch.isNewer === false;
    const days = batch.dates.map(dateSlug).join(", ");
    return NextResponse.json({
      success: true,
      backDated,
      message: backDated
        ? `Loaded ${batch.receivedRows.toLocaleString()} rows for ${days} as historical data. ` +
          `Current stock still shows the newer count.`
        : `Loaded ${batch.receivedRows.toLocaleString()} rows of ${batch.fileType} data for ${days}.`,
      receivedRows: batch.receivedRows,
      skipped: batch.skipped ?? {},
    });
  } catch (error) {
    console.error("Upload commit error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
