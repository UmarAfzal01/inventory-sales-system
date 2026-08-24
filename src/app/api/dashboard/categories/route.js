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

    // Fetch up to 50k products to aggregate category metrics
    const products = await Product.find(query).limit(200000).lean();

    const categoryMap = {};

    products.forEach((prod) => {
      const category = prod.firstLevelCategory || "UNCATEGORIZED";
      
      if (!categoryMap[category]) {
        categoryMap[category] = {
          categoryName: category,
          totalSales: 0,
          positiveSales: 0,
          negativeSales: 0,
          totalInventory: 0,
          negativeStockCount: 0,
          zeroStockCount: 0,
          productCount: 0,
        };
      }

      categoryMap[category].productCount++;

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

              const sale = Number(branchData?.sale) || 0;
              const inv = Number(branchData?.inventory) || 0;

              categoryMap[category].totalSales += sale;
              if (sale > 0) categoryMap[category].positiveSales += sale;
              if (sale < 0) categoryMap[category].negativeSales += sale;

              categoryMap[category].totalInventory += inv;
              if (inv < 0) prodHasNegative = true;
              if (inv === 0) prodHasZero = true;
            }
          }
        }
      }

      if (prodHasNegative) categoryMap[category].negativeStockCount++;
      if (prodHasZero) categoryMap[category].zeroStockCount++;
    });

    // Convert map to array and sort by total sales descending
    const categoriesArray = Object.values(categoryMap).sort((a, b) => b.totalSales - a.totalSales);

    return NextResponse.json({
      success: true,
      data: categoriesArray,
    });
  } catch (error) {
    console.error("Category API error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}   