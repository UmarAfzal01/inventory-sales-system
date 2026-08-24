import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { readDashboard } from "@/lib/rollups";

export const runtime = "nodejs";

/**
 * @deprecated Use GET /api/dashboard, which returns the category breakdown
 * alongside the rest of the dashboard in a single round trip. Kept working for
 * any existing caller; it no longer streams the collection into Node.
 */
export async function GET(req) {
  try {
    await dbConnect();
    const { searchParams } = req.nextUrl;
    const { categories } = await readDashboard({
      branch: searchParams.get("branch") || "ALL",
      type: searchParams.get("type") || "ALL",
      sellingStatus: searchParams.get("sellingStatus") || "ALL",
    });

    return NextResponse.json({ success: true, data: categories });
  } catch (error) {
    console.error("Category API error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
