import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";

export async function GET() {
  try {
    await dbConnect();
    console.log("Starting corrected cache migration for all products...");

    const batchSize = 1000;
    let skip = 0;
    let processedCount = 0;
    let hasMore = true;

    while (hasMore) {
      // Use .lean() so records are plain JavaScript objects, making iteration 100% bulletproof
      const chunk = await Product.find({}).lean().skip(skip).limit(batchSize);

      if (chunk.length === 0) {
        hasMore = false;
        break;
      }

      const bulkOps = chunk.map((prod) => {
        let totalSales = 0;
        let totalInventory = 0;
        let hasNegativeStock = false;
        let hasZeroStock = false;

        const records = prod.records;
        if (records) {
          const years =
            records instanceof Map ? records.values() : Object.values(records);

          for (const yearObj of years) {
            if (!yearObj) continue;
            const months =
              yearObj instanceof Map
                ? yearObj.values()
                : Object.values(yearObj);

            for (const monthObj of months) {
              if (!monthObj) continue;
              const days =
                monthObj instanceof Map
                  ? monthObj.values()
                  : Object.values(monthObj);

              for (const dayObj of days) {
                if (!dayObj || !dayObj.branches) continue;

                const branches =
                  dayObj.branches instanceof Map
                    ? dayObj.branches.values()
                    : Object.values(dayObj.branches);

                for (const branchData of branches) {
                  if (branchData) {
                    const sale = Number(branchData.sale) || 0;
                    const inv = Number(branchData.inventory) || 0;

                    totalSales += sale;
                    totalInventory += inv;
                    if (inv < 0) hasNegativeStock = true;
                    if (inv === 0) hasZeroStock = true;
                  }
                }
              }
            }
          }
        }

        return {
          updateOne: {
            filter: { _id: prod._id },
            update: {
              $set: {
                cachedTotalSales: Number(totalSales),
                cachedTotalInventory: Number(totalInventory),
                cachedNegativeStock: Boolean(hasNegativeStock),
                cachedZeroStock: Boolean(hasZeroStock),
              },
            },
          },
        };
      });

      await Product.bulkWrite(bulkOps);

      processedCount += chunk.length;
      skip += batchSize;
      console.log(`Migrated batch... total processed: ${processedCount}`);

      if (chunk.length < batchSize) {
        hasMore = false;
      }
    }

    console.log("Migration completed successfully!");
    return NextResponse.json({
      success: true,
      message: `Successfully migrated and cached ${processedCount} products!`,
    });
  } catch (error) {
    console.error("Migration error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }
}
