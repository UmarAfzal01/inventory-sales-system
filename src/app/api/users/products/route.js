import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL } from "@/lib/schema";
import { requireUser } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * Product search for the scope editor.
 *
 * Capped and search-only: the catalogue is 194k rows, so the editor never lists
 * them all. A barcode-looking term matches by prefix, anything else by name.
 * `id` resolves already-selected barcodes back to names for display.
 */
export async function GET(req) {
  const { error } = await requireUser(req, { admin: true });
  if (error) return error;
  await dbConnect();

  const params = req.nextUrl.searchParams;
  const term = (params.get("q") || "").trim();
  const ids = params.getAll("id");
  const categories = params.getAll("category");
  const subCategories = params.getAll("subCategory");
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Confined to the categories the scope already restricts to. Without this an
  // admin could pick a product outside them, and because the dimensions
  // intersect the result is a scope that matches nothing at all.
  const within = {};
  if (categories.length) within.category = { $in: categories };
  if (subCategories.length) within.subCategory = { $in: subCategories };

  let query;
  if (ids.length) {
    query = { _id: { $in: ids } };
  } else if (term) {
    query = {
      ...within,
      $or: [
        { _id: { $regex: "^" + escape(term) } },
        { articleName: { $regex: escape(term), $options: "i" } },
      ],
    };
  } else {
    // No term: behave like the other dropdowns and list what is available,
    // rather than sitting empty until something is typed.
    query = within;
  }

  const LIMIT = ids.length ? Math.min(ids.length, 500) : 200;
  const cursor = mongoose.connection.db
    .collection(COL.PRODUCTS)
    .find(query, { projection: { articleName: 1, category: 1, subCategory: 1 } });
  if (!ids.length) cursor.sort({ articleName: 1 });

  const products = await cursor.limit(LIMIT + 1).toArray();
  // One extra was fetched purely to detect the cut-off, so the UI can say the
  // list is partial instead of implying these are all of them.
  const truncated = products.length > LIMIT;
  if (truncated) products.pop();

  return NextResponse.json({
    success: true,
    truncated,
    products: products.map((p) => ({
      barcode: p._id,
      articleName: p.articleName,
      category: p.category,
      subCategory: p.subCategory,
    })),
  });
}
