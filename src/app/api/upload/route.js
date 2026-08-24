import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Product from "@/models/Product";
import * as XLSX from "xlsx";

export async function POST(req) {
  try {
    await dbConnect();

    const formData = await req.formData();
    const file = formData.get("file");
    const fileType = formData.get("fileType") || "sale"; // Fallback default
    const action = formData.get("action") || "upload";    // Fallback default
    const manualYear = formData.get("year"); 

    // Only strictly require the file object
    if (!file) {
      return NextResponse.json({ success: false, error: "Missing required file." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: "Uploaded file is empty." }, { status: 400 });
    }

    const staticKeys = [
      "1ST LEVEL CATEGORY", "1ST LEVEL CATE", "LAST LEVEL CATEGORY", "ARTICLE NAME", 
      "BARCODE", "TYPE", "SELLING STATUS", "MONTH", "DAY", "COST PRICE", "SALE RATE"
    ];

    const detectedDaysSet = new Set();
    const detectedMonthsSet = new Set();

    const processedRows = rows.map(row => {
      const normalizedRow = {};
      Object.keys(row).forEach((k) => {
        const cleanKey = k.trim().toUpperCase();
        normalizedRow[cleanKey] = row[k];
      });

      const rawMonthField = String(normalizedRow["MONTH"] || "").trim();
      const rawDay = String(normalizedRow["DAY"] || "").trim();

      let monthStr = rawMonthField;
      if (rawMonthField.includes(" ")) {
        const parts = rawMonthField.split(" ");
        monthStr = parts[parts.length - 1]; 
      }

      if (monthStr) detectedMonthsSet.add(monthStr);
      if (rawDay) detectedDaysSet.add(rawDay);

      return {
        ...normalizedRow,
        _parsedMonth: monthStr,
        _parsedDay: rawDay
      };
    });

    // STEP 1: PREVIEW ACTION
    if (action === "preview") {
      return NextResponse.json({
        success: true,
        isPreview: true,
        summary: {
          totalRows: rows.length,
          months: Array.from(detectedMonthsSet),
          days: Array.from(detectedDaysSet).sort((a, b) => Number(a) - Number(b)),
        }
      });
    }

    // STEP 2: UPLOAD & MERGE ACTION
    const bulkOps = [];

    for (const row of processedRows) {
      const barcode = String(row["BARCODE"] || "").trim();
      if (!barcode) continue;

      const articleName = row["ARTICLE NAME"] || "Unknown";
      const firstLevelCategory = row["1ST LEVEL CATEGORY"] || row["1ST LEVEL CATE"] || "";
      const lastLevelCategory = row["LAST LEVEL CATEGORY"] || "";
      const type = row["TYPE"] || "";
      const sellingStatus = row["SELLING STATUS"] || "";

      const monthVal = row._parsedMonth || "AUG-26"; // Fallback if missing
      const dayVal = row._parsedDay || "1";          // Fallback if missing
      
      let year = manualYear;
      if (!year && monthVal.includes("-")) {
        const splitMonth = monthVal.split("-");
        const yrSuffix = splitMonth[splitMonth.length - 1];
        year = yrSuffix.length === 2 ? `20${yrSuffix}` : yrSuffix;
      }
      if (!year) year = "2026";

      const branchUpdates = {};
      const branchKeys = Object.keys(row).filter(
        (key) => !staticKeys.includes(key) && !key.startsWith("_")
      );

      for (const branch of branchKeys) {
        const qty = Number(row[branch]) || 0;
        // Dot notation safely merges without overwriting inventory
        branchUpdates[`records.${year}.${monthVal}.DAY${dayVal}.branches.${branch}.${fileType}`] = qty;
      }

      bulkOps.push({
        updateOne: {
          filter: { barcode },
          update: {
            $set: {
              articleName,
              firstLevelCategory,
              lastLevelCategory,
              type,
              sellingStatus,
              ...branchUpdates,
            },
          },
          upsert: true,
        },
      });

      if (bulkOps.length >= 1000) {
        await Product.bulkWrite(bulkOps);
        bulkOps.length = 0;
      }
    }

    if (bulkOps.length > 0) {
      await Product.bulkWrite(bulkOps);
    }

    return NextResponse.json({ 
      success: true, 
      message: `Successfully processed multi-day ${fileType.toUpperCase()} file (${rows.length} rows across ${detectedDaysSet.size} days)!` 
    });

  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}