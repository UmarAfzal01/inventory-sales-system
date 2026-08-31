import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { ensureSchema } from "@/lib/schema";
import { parseIsoDate } from "@/lib/ingest";
import { readDashboard, readProducts } from "@/lib/warehouse";
import { requireUser } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * The whole dashboard: headline stats, category breakdown, filter options.
 * Reads only the pre-aggregated cubes — never the fact tables.
 *
 * Params: branch, type, sellingStatus, from, to, category (yyyy-mm-dd, inclusive).
 */
export async function GET(req) {
  try {
    // Any signed-in account may read; viewers exist precisely for this.
    const { error: authError } = await requireUser(req);
    if (authError) return authError;

    await dbConnect();
    await ensureSchema(mongoose.connection.db);

    const q = req.nextUrl.searchParams;

    // Three drill-down levels, chosen by which parameters are present:
    //   neither          -> first-level categories   (reads the cubes)
    //   category         -> sub-categories within it (reads the facts)
    //   category + sub   -> the products within that (reads the facts)
    const category = q.get("category") || null;
    // A clicked metric card narrows the list at whichever level is showing.
    // The headline figures stay computed over everything, so the card that was
    // clicked keeps displaying its own total.
    const metricFilter = q.get("metricFilter") || null;
    const subCategory = q.get("subCategory");
    const search = (q.get("q") || "").trim();

    // A search term always yields products, whatever level the user is on —
    // scoped to the category/sub-category if they have drilled in, global if not.
    if (search || (category && subCategory !== null)) {
      const level3 = await readProducts({
        branch: q.get("branch") || "ALL",
        type: q.get("type") || "ALL",
        sellingStatus: q.get("sellingStatus") || "ALL",
        from: parseIsoDate(q.get("from")),
        to: parseIsoDate(q.get("to")),
        category,
        subCategory,
        q: search,
        metricFilter,
        page: Math.max(1, parseInt(q.get("page") || "1", 10) || 1),
        pageSize: Math.min(200, Math.max(1, parseInt(q.get("pageSize") || "50", 10) || 50)),
      });
      return NextResponse.json({ success: true, level: "products", ...level3 });
    }

    const data = await readDashboard({
      branch: q.get("branch") || "ALL",
      type: q.get("type") || "ALL",
      sellingStatus: q.get("sellingStatus") || "ALL",
      from: parseIsoDate(q.get("from")),
      to: parseIsoDate(q.get("to")),
      category,
      metricFilter,
    });

    if (!data.ready) {
      return NextResponse.json({
        success: false,
        needsUpload: true,
        error: "No data yet. Upload a sales or inventory sheet to get started.",
      });
    }

    return NextResponse.json({
      success: true,
      level: category ? "subCategories" : "categories",
      ...data,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}