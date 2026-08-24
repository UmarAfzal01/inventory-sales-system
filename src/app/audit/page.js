"use client";
import { useState } from "react";
import * as XLSX from "xlsx";

export default function AuditPage() {
  const [inventoryFile, setInventoryFile] = useState(null);
  const [salesFile, setSalesFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [missingProducts, setMissingProducts] = useState([]);
  const [checkedStats, setCheckedStats] = useState(null);

  const handleAudit = async (e) => {
    e.preventDefault();
    if (!inventoryFile || !salesFile) {
      alert("Please select both Inventory and Sales files.");
      return;
    }

    setLoading(true);
    setMissingProducts([]);
    setCheckedStats(null);

    try {
      // 1. Read Inventory File
      const invBuffer = await inventoryFile.arrayBuffer();
      const invWorkbook = XLSX.read(invBuffer, { type: "buffer" });
      const invSheet = invWorkbook.Sheets[invWorkbook.SheetNames[0]];
      const invRows = XLSX.utils.sheet_to_json(invSheet);

      // Extract all unique barcodes from inventory into a Set for O(1) fast lookup
      const inventoryBarcodes = new Set();
      invRows.forEach((row) => {
        // Normalize keys to find barcode
        const barcodeKey = Object.keys(row).find((k) => k.trim().toUpperCase() === "BARCODE");
        if (barcodeKey && row[barcodeKey] !== undefined) {
          inventoryBarcodes.add(String(row[barcodeKey]).trim());
        }
      });

      // 2. Read Sales File
      const salesBuffer = await salesFile.arrayBuffer();
      const salesWorkbook = XLSX.read(salesBuffer, { type: "buffer" });
      const salesSheet = salesWorkbook.Sheets[salesWorkbook.SheetNames[0]];
      const salesRows = XLSX.utils.sheet_to_json(salesSheet);

      // 3. Compare and find missing
      const missing = [];
      const checkedBarcodes = new Set();

      salesRows.forEach((row) => {
        const normalizedRow = {};
        Object.keys(row).forEach((k) => {
          normalizedRow[k.trim().toUpperCase()] = row[k];
        });

        const barcode = String(normalizedRow["BARCODE"] || "").trim();
        const articleName = normalizedRow["ARTICLE NAME"] || "Unknown Article";

        if (barcode && !inventoryBarcodes.has(barcode)) {
          // Avoid duplicate rows in the mismatch report if sales file has repeat entries
          if (!checkedBarcodes.has(barcode)) {
            checkedBarcodes.add(barcode);
            missing.push({ barcode, articleName });
          }
        }
      });

      setMissingProducts(missing);
      setCheckedStats({
        totalSalesRows: salesRows.length,
        totalInventoryBarcodes: inventoryBarcodes.size,
        missingCount: missing.length,
      });
    } catch (error) {
      console.error("Audit error:", error);
      alert("Error reading files. Make sure they are valid Excel/CSV files.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 font-sans">
      <div className="max-w-4xl mx-auto bg-white p-6 rounded-xl shadow-md border border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Inventory vs Sales Barcode Audit</h1>
        <p className="text-sm text-gray-600 mb-6">
          Upload both files below to check if any products appearing in your sales sheet are missing from your inventory master file.
        </p>

        <form onSubmit={handleAudit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">1. Inventory Master File (.xlsx / .csv)</label>
              <input
                type="file"
                accept=".xlsx, .xls, .csv"
                onChange={(e) => setInventoryFile(e.target.files[0])}
                className="w-full bg-white text-gray-900 border border-gray-300 rounded-lg p-2 text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">2. Sales File (.xlsx / .csv)</label>
              <input
                type="file"
                accept=".xlsx, .xls, .csv"
                onChange={(e) => setSalesFile(e.target.files[0])}
                className="w-full bg-white text-gray-900 border border-gray-300 rounded-lg p-2 text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 transition disabled:bg-blue-300 cursor-pointer"
          >
            {loading ? "Comparing Files..." : "Run Mismatch Audit"}
          </button>
        </form>

        {checkedStats && (
          <div className="mt-8 grid grid-cols-3 gap-4 text-center">
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
              <p className="text-xs text-blue-600 font-semibold uppercase">Total Inventory Items</p>
              <p className="text-xl font-bold text-blue-900">{checkedStats.totalInventoryBarcodes}</p>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <p className="text-xs text-gray-600 font-semibold uppercase">Total Sales Rows Checked</p>
              <p className="text-xl font-bold text-gray-900">{checkedStats.totalSalesRows}</p>
            </div>
            <div className={`p-4 rounded-lg border ${checkedStats.missingCount > 0 ? "bg-red-50 border-red-100" : "bg-green-50 border-green-100"}`}>
              <p className={`text-xs font-semibold uppercase ${checkedStats.missingCount > 0 ? "text-red-600" : "text-green-600"}`}>
                Missing From Inventory
              </p>
              <p className={`text-xl font-bold ${checkedStats.missingCount > 0 ? "text-red-900" : "text-green-900"}`}>
                {checkedStats.missingCount}
              </p>
            </div>
          </div>
        )}

        {missingProducts.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Mismatched Products (In Sales, Not in Inventory)</h2>
            <div className="border border-gray-200 rounded-lg overflow-hidden max-h-96 overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-gray-100 sticky top-0">
                  <tr>
                    <th className="p-3 text-xs font-semibold text-gray-700 uppercase border-b">#</th>
                    <th className="p-3 text-xs font-semibold text-gray-700 uppercase border-b">Barcode</th>
                    <th className="p-3 text-xs font-semibold text-gray-700 uppercase border-b">Article Name</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 text-sm">
                  {missingProducts.map((item, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="p-3 text-gray-500">{index + 1}</td>
                      <td className="p-3 font-mono text-gray-900">{item.barcode}</td>
                      <td className="p-3 text-gray-800">{item.articleName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}