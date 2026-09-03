import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL, BRANCH_CODES } from "@/lib/schema";
import { requireUser } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * The choices behind the scope editor: branches, categories, and the
 * sub-categories under each. Products are not listed — there are 194k of them,
 * so the editor searches for those instead.
 */
export async function GET(req) {
  const { error } = await requireUser(req, { admin: true });
  if (error) return error;
  await dbConnect();
  const db = mongoose.connection.db;

  const [branches, tree] = await Promise.all([
    db.collection(COL.COVERAGE).distinct("branch"),
    db
      .collection(COL.PRODUCTS)
      .aggregate([
        { $group: { _id: { c: "$category", s: "$subCategory" } } },
        { $group: { _id: "$_id.c", subCategories: { $addToSet: "$_id.s" } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
  ]);

  return NextResponse.json({
    success: true,
    branches: (branches.length ? branches : BRANCH_CODES).sort(),
    categories: tree.map((t) => ({
      category: t._id,
      subCategories: t.subCategories.filter(Boolean).sort(),
    })),
  });
}
