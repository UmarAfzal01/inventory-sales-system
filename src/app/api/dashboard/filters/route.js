import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";

export async function GET(req) {
  try {
    await dbConnect();
    const { searchParams } = new URL(req.url);
    const typeFilter = searchParams.get("type") || "ALL";
    const statusFilter = searchParams.get("sellingStatus") || "ALL";

    const query = {};
    if (typeFilter !== "ALL") query.type = typeFilter;
    if (statusFilter !== "ALL") query.sellingStatus = statusFilter;

    const [totalProducts, types, statuses, sampleProducts] = await Promise.all([
      Product.countDocuments(query),
      Product.distinct("type"),
      Product.distinct("sellingStatus"),
      Product.find().select("records").limit(500).lean(),
    ]);

    const branchesSet = new Set();
    sampleProducts.forEach((p) => {
      if (!p.records) return;
      const years = p.records instanceof Map ? p.records.values() : Object.values(p.records);
      for (const y of years) {
        if (!y) continue;
        const months = y instanceof Map ? y.values() : Object.values(y);
        for (const m of months) {
          if (!m) continue;
          const days = m instanceof Map ? m.values() : Object.values(m);
          for (const d of days) {
            if (d && d.branches) {
              const bMap = d.branches;
              const bKeys = bMap instanceof Map ? bMap.keys() : Object.keys(bMap);
              for (const bk of bKeys) branchesSet.add(bk);
            }
          }
        }
      }
    });

    return NextResponse.json({
      success: true,
      data: {
        totalProducts,
        branches: Array.from(branchesSet).sort(),
        types: types.filter(Boolean).sort(),
        statuses: statuses.filter(Boolean).sort(),
      },
    });
  } catch (error) {
    console.error("Filters API error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}