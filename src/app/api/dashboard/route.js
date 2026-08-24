import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { readDashboard } from "@/lib/rollups";

export const runtime = "nodejs";

/**
 * The whole dashboard: headline stats, per-category breakdown, filter options.
 *
 * Reads only the pre-aggregated rollups, which uploads maintain incrementally.
 * Nothing here touches the `products` collection.
 */
export async function GET(req) {
  try {
    await dbConnect();

    const { searchParams } = req.nextUrl;
    const data = await readDashboard({
      branch: searchParams.get("branch") || "ALL",
      type: searchParams.get("type") || "ALL",
      sellingStatus: searchParams.get("sellingStatus") || "ALL",
    });

    if (!data.ready) {
      return NextResponse.json({
        success: false,
        needsBackfill: true,
        error: "Dashboard data has not been built yet. Run POST /api/dashboard/refresh once.",
      });
    }

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
