import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { readDashboard } from "@/lib/rollups";

export const runtime = "nodejs";

/**
 * @deprecated Use GET /api/dashboard, which returns the filter options alongside
 * the rest of the dashboard in a single round trip.
 */
export async function GET(req) {
  try {
    await dbConnect();
    const { searchParams } = req.nextUrl;
    const { stats, filtersList } = await readDashboard({
      type: searchParams.get("type") || "ALL",
      sellingStatus: searchParams.get("sellingStatus") || "ALL",
    });

    return NextResponse.json({
      success: true,
      data: { totalProducts: stats.totalProducts, ...filtersList },
    });
  } catch (error) {
    console.error("Filters API error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
