import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";

export async function GET(req) {
  try {
    await dbConnect();
    const { searchParams } = new URL(req.url);
    const branchFilter = searchParams.get("branch") || "ALL";
    const typeFilter = searchParams.get("type") || "ALL";
    const statusFilter = searchParams.get("sellingStatus") || "ALL";

    const query = {};
    if (typeFilter !== "ALL") query.type = typeFilter;
    if (statusFilter !== "ALL") query.sellingStatus = statusFilter;

    // Fetch up to 50k products and aggregate in memory
    const products = await Product.find(query).limit(200000).lean();

    let totalSales = 0;
    let positiveSales = 0;
    let negativeSales = 0;

    products.forEach((prod) => {
      if (!prod.records) return;

      const years = prod.records instanceof Map ? prod.records.values() : Object.values(prod.records);
      for (const yearObj of years) {
        if (!yearObj) continue;
        const months = yearObj instanceof Map ? yearObj.values() : Object.values(yearObj);

        for (const monthObj of months) {
          if (!monthObj) continue;
          const days = monthObj instanceof Map ? monthObj.values() : Object.values(monthObj);

          for (const dayObj of days) {
            if (!dayObj || !dayObj.branches) continue;

            const branchesMap = dayObj.branches;
            const branchEntries = branchesMap instanceof Map ? branchesMap.entries() : Object.entries(branchesMap);

            for (const [branchKey, branchData] of branchEntries) {
              if (branchFilter !== "ALL" && branchKey !== branchFilter) continue;

              const sale = Number(branchData?.sale) || 0;
              totalSales += sale;
              if (sale > 0) positiveSales += sale;
              if (sale < 0) negativeSales += sale;
            }
          }
        }
      }
    });

    return NextResponse.json({
      success: true,
      data: { totalSales, positiveSales, negativeSales },
    });
  } catch (error) {
    console.error("Sales API error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}