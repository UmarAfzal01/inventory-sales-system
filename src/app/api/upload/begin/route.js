import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL, ensureSchema } from "@/lib/schema";
import { validateHeaders, parseIsoDate, normHeader, dateSlug } from "@/lib/ingest";
import { requireUser } from "@/lib/guard";
import { beginBatch } from "@/lib/warehouse";

export const runtime = "nodejs";
export const maxDuration = 60;

const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Phase 1 of a chunked upload.
 *
 * The browser has already parsed the workbook, so only metadata arrives here.
 * That means the server never sees the file and cannot check its magic bytes —
 * but every row is still validated in the chunk phase, which is where a
 * malformed value could actually do damage.
 */
export async function POST(req) {
  try {
    const { user, error } = await requireUser(req, { admin: true });
    if (error) return error;

    await dbConnect();
    const database = mongoose.connection.db;
    await ensureSchema(database, { force: true });

    const body = await req.json().catch(() => ({}));
    const fileType = body.fileType === "inventory" ? "inventory" : "sale";
    const headers = (body.headers ?? []).map(normHeader);
    const dates = (body.dates ?? []).map((d) => parseIsoDate(d)).filter(Boolean);

    const headerCheck = validateHeaders(headers, fileType);
    if (!headerCheck.ok) {
      return NextResponse.json(
        { success: false, stage: "headers", errors: headerCheck.errors, warnings: headerCheck.warnings },
        { status: 400 }
      );
    }
    if (!dates.length) {
      return NextResponse.json(
        { success: false, error: "No usable dates were found in this sheet." },
        { status: 400 }
      );
    }
    if (!body.fileHash) {
      return NextResponse.json({ success: false, error: "Missing file fingerprint." }, { status: 400 });
    }

    const already = await database
      .collection(COL.BATCHES)
      .findOne({ fileHash: body.fileHash, status: "committed" });
    if (already) {
      return NextResponse.json(
        {
          success: false,
          error: `This exact file was already uploaded on ${already.uploadedAt.toISOString().slice(0, 10)}.`,
        },
        { status: 409 }
      );
    }

    // A back-dated inventory sheet is recorded as history but must not become
    // the current stock position.
    let isNewer = true;
    let currentAsOf = null;
    if (fileType === "inventory") {
      const held = await database
        .collection(COL.INVENTORY_STATE)
        .findOne({}, { projection: { asOf: 1 } });
      currentAsOf = held?.asOf ?? null;
      isNewer = !currentAsOf || dates[0] >= currentAsOf;
    }

    // Claiming the running slot IS the lock — a partial unique index permits
    // only one batch with status "running".
    const batchId = new mongoose.Types.ObjectId();
    const doc = {
      _id: batchId,
      fileHash: body.fileHash,
      fileName: body.fileName ?? "upload.xlsx",
      fileSize: body.fileSize ?? 0,
      fileType,
      uploadedBy: user.email,
      dates,
      isNewer,
      branchColumns: headerCheck.branchColumns,
      totalRows: body.totalRows ?? 0,
      receivedRows: 0,
      appliedSeq: [],
      status: "running",
      uploadedAt: new Date(),
    };

    const claim = () => database.collection(COL.BATCHES).insertOne(doc);
    try {
      await claim();
    } catch (err) {
      if (err.code !== 11000) throw err;
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

    // Indexes come down and the replaced rows go, once, before any batch lands.
    const dropped = await beginBatch({ database, fileType, dates, isNewer });
    await database.collection(COL.BATCHES).updateOne({ _id: batchId }, { $set: { dropped } });

    return NextResponse.json({
      success: true,
      batchId: String(batchId),
      isNewer,
      heldAsOf: currentAsOf ? dateSlug(currentAsOf) : null,
      branchColumns: headerCheck.branchColumns,
      dates: dates.map(dateSlug),
      warnings: headerCheck.warnings,
    });
  } catch (error) {
    console.error("Upload begin error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
