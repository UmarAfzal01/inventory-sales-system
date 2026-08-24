import mongoose from "mongoose";

const branchMetricsSchema = new mongoose.Schema({
  sale: { type: Number, default: 0 },
  inventory: { type: Number, default: 0 },
}, { _id: false });

const dailyRecordSchema = new mongoose.Schema({
  branches: {
    type: Map,
    of: branchMetricsSchema,
    default: {},
  },
}, { _id: false });

const productSchema = new mongoose.Schema({
  barcode: { type: String, required: true, unique: true, index: true },
  articleName: { type: String, required: true },
  firstLevelCategory: { type: String, default: "" },
  lastLevelCategory: { type: String, default: "" },
  type: { type: String, default: "" },
  sellingStatus: { type: String, default: "" },

  // CACHED FIELDS FOR INSTANT AGGREGATION
  cachedTotalSales: { type: Number, default: 0, index: true },
  cachedTotalInventory: { type: Number, default: 0 },
  cachedNegativeStock: { type: Boolean, default: false },
  cachedZeroStock: { type: Boolean, default: false },

  records: {
    type: Map,
    of: {
      type: Map,
      of: {
        type: Map,
        of: dailyRecordSchema,
      },
    },
    default: {},
  },
}, { timestamps: true });

// Compound index for lightning-fast filtering on dashboard queries
productSchema.index({ type: 1, sellingStatus: 1 });

export default mongoose.models.Product || mongoose.model("Product", productSchema);