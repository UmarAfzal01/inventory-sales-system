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

    let totalInventory = 0;
    let negativeStock = 0;
    let zeroStock = 0;

    products.forEach((prod) => {
      if (!prod.records) return;

      let prodHasNegative = false;
      let prodHasZero = false;

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

              const inv = Number(branchData?.inventory) || 0;
              totalInventory += inv;
              if (inv < 0) prodHasNegative = true;
              if (inv === 0) prodHasZero = true;
            }
          }
        }
      }

      if (prodHasNegative) negativeStock++;
      if (prodHasZero) zeroStock++;
    });

    return NextResponse.json({
      success: true,
      data: { totalInventory, negativeStock, zeroStock },
    });
  } catch (error) {
    console.error("Inventory API error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}