import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { backfillFromProducts, refreshDerived } from "@/lib/rollups";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Rebuilds the dashboard rollups.
 *
 * POST /api/dashboard/refresh              recomputes counts and filter options
 *                                          from product_state (fast)
 * POST /api/dashboard/refresh?backfill=1   also rebuilds rollup_daily and
 *                                          product_state from `products`
 *
 * The backfill is a one-time migration for data uploaded before rollups existed.
 * Normal uploads maintain the rollups themselves and never need it.
 */
export async function POST(req) {
  try {
    await dbConnect();
    const startedAt = Date.now();
    const backfill = req.nextUrl.searchParams.get("backfill") === "1";

    const result = backfill ? await backfillFromProducts() : await refreshDerived();

    return NextResponse.json({
      success: true,
      mode: backfill ? "backfill" : "refresh",
      message: `Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      ...result,
    });
  } catch (error) {
    console.error("Rollup refresh error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = POST;
