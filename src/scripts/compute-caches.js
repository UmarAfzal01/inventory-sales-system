import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";

export async function runCacheMigration() {
  await dbConnect();
  console.log("Starting cache migration for all products...");

  const batchSize = 2000;
  let skip = 0;
  let processedCount = 0;
  let hasMore = true;

  while (hasMore) {
    const chunk = await Product.find({}).skip(skip).limit(batchSize);

    if (chunk.length === 0) {
      hasMore = false;
      break;
    }

    const bulkOps = chunk.map((prod) => {
      let totalSales = 0;
      let totalInventory = 0;
      let hasNegativeStock = false;
      let hasZeroStock = false;

      if (prod.records) {
        for (const yearObj of Object.values(prod.records)) {
          if (!yearObj) continue;
          for (const monthObj of Object.values(yearObj)) {
            if (!monthObj) continue;
            for (const dayObj of Object.values(monthObj)) {
              if (dayObj && dayObj.branches) {
                for (const branchData of Object.values(dayObj.branches)) {
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
              cachedTotalSales: totalSales,
              cachedTotalInventory: totalInventory,
              cachedNegativeStock: hasNegativeStock,
              cachedZeroStock: hasZeroStock,
            },
          },
        },
      };
    });

    // Execute bulk write for maximum speed
    await Product.bulkWrite(bulkOps);

    processedCount += chunk.length;
    skip += batchSize;
    console.log(`Processed ${processedCount} products...`);

    if (chunk.length < batchSize) {
      hasMore = false;
    }
  }

  console.log("Cache migration completed successfully!");
}