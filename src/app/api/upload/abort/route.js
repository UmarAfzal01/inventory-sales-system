import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL } from "@/lib/schema";
import { requireUser } from "@/lib/guard";
import { discardStaging } from "@/lib/warehouse";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Releases a failed upload.
 *
 * The indexes go back even though the data is incomplete: leaving them off
 * would put every dashboard query on a collection scan, which is a worse
 * failure than the partial load itself. The batch is marked failed, and the
 * dates it was replacing hold partial data until the file is uploaded again.
 */
export async function POST(req) {
  try {
    const { error } = await requireUser(req, { admin: true });
    if (error) return error;

    await dbConnect();
    const database = mongoose.connection.db;

    const { batchId, reason } = await req.json().catch(() => ({}));
    let _id;
    try {
      _id = new mongoose.Types.ObjectId(String(batchId));
    } catch {
      return NextResponse.json({ success: false, error: "Unknown batch." }, { status: 404 });
    }

    const batch = await database.collection(COL.BATCHES).findOne({ _id });
    if (!batch) return NextResponse.json({ success: false, error: "Unknown batch." }, { status: 404 });

    // Nothing to undo in the live collections — a chunked upload writes only
    // to staging, and the swap happens in commit. Dropping staging is the whole
    // rollback.
    await discardStaging({ database, fileType: batch.fileType, dates: batch.dates });

    await database.collection(COL.BATCHES).updateOne(
      { _id },
      { $set: { status: "failed", error: String(reason ?? "Cancelled").slice(0, 500) } }
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Upload abort error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
