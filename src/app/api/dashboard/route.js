import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { ensureSchema } from "@/lib/schema";
import { parseIsoDate } from "@/lib/ingest";
import { readDashboard } from "@/lib/warehouse";

export const runtime = "nodejs";

/**
 * The whole dashboard: headline stats, category breakdown, filter options.
 * Reads only the pre-aggregated cubes — never the fact tables.
 *
 * Params: branch, type, sellingStatus, from, to, category (yyyy-mm-dd, inclusive).
 */
export async function GET(req) {
  try {
    await dbConnect();
    await ensureSchema(mongoose.connection.db);

    const q = req.nextUrl.searchParams;
    const data = await readDashboard({
      branch: q.get("branch") || "ALL",
      type: q.get("type") || "ALL",
      sellingStatus: q.get("sellingStatus") || "ALL",
      from: parseIsoDate(q.get("from")),
      to: parseIsoDate(q.get("to")),
      category: q.get("category") || null, // Pass the category drill-down parameter here
    });

    if (!data.ready) {
      return NextResponse.json({
        success: false,
        needsUpload: true,
        error: "No data yet. Upload a sales or inventory sheet to get started.",
      });
    }

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}