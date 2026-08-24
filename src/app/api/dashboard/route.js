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

    const matchQuery = {};
    if (typeFilter !== "ALL") matchQuery.type = typeFilter;
    if (statusFilter !== "ALL") matchQuery.sellingStatus = statusFilter;

    // 1. Fetch fast counts and distinct options concurrently
    const [totalProducts, types, statuses] = await Promise.all([
      Product.countDocuments(matchQuery),
      Product.distinct("type"),
      Product.distinct("sellingStatus"),
    ]);

    let totalInventory = 0;
    let totalSales = 0;
    let positiveSales = 0;
    let negativeSales = 0;
    let negativeStockCount = 0;
    let zeroStockCount = 0;
    const branchesSet = new Set();

    // 2. Process data in chunks (batches of 5,000 documents) to guarantee zero memory overflow
    const batchSize = 5000;
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      const chunk = await Product.find(matchQuery)
        .select("records type sellingStatus")
        .lean()
        .skip(skip)
        .limit(batchSize);

      if (chunk.length === 0) {
        hasMore = false;
        break;
      }

      chunk.forEach((prod) => {
        let productInventorySum = 0;
        let productHasNegative = false;
        let productHasZero = false;

        if (prod.records) {
          // Iterate through dynamic year objects
          for (const yearKey of Object.keys(prod.records)) {
            const yearObj = prod.records[yearKey];
            if (!yearObj) continue;

            // Iterate through months
            for (const monthKey of Object.keys(yearObj)) {
              const monthObj = yearObj[monthKey];
              if (!monthObj) continue;

              // Iterate through days
              for (const dayKey of Object.keys(monthObj)) {
                const dayObj = monthObj[dayKey];
                if (dayObj && dayObj.branches) {

                  // Iterate through branches
                  for (const [branchKey, branchData] of Object.entries(dayObj.branches)) {
                    branchesSet.add(branchKey);

                    // Skip if a specific branch filter is selected and doesn't match
                    if (branchFilter !== "ALL" && branchKey !== branchFilter) continue;

                    const inv = Number(branchData.inventory) || 0;
                    const sale = Number(branchData.sale) || 0;

                    // Accumulate totals across all chunks
                    totalInventory += inv;
                    totalSales += sale;
                    if (sale > 0) positiveSales += sale;
                    if (sale < 0) negativeSales += sale;

                    productInventorySum += inv;
                    if (inv < 0) productHasNegative = true;
                    if (inv === 0) productHasZero = true;
                  }
                }
              }
            }
          }
        }

        if (productHasNegative) negativeStockCount++;
        else if (productHasZero) zeroStockCount++;
      });

      skip += batchSize;
      if (chunk.length < batchSize) {
        hasMore = false;
      }
    }

    const stats = {
      totalProducts,
      totalInventory,
      totalSales,
      positiveSales,
      negativeSales,
      negativeStock: negativeStockCount,
      zeroStock: zeroStockCount,
    };

    const filtersList = {
      branches: Array.from(branchesSet).sort(),
      types: types.filter(Boolean).sort(),
      statuses: statuses.filter(Boolean).sort(),
    };

    return NextResponse.json({
      success: true,
      stats,
      filtersList,
    });
  } catch (error) {
    console.error("Dashboard chunk processing error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}