"use client";

import { useState } from "react";

export default function FileUpload() {
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState("sale");
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const [year, setYear] = useState("2026");
  const [month, setMonth] = useState("AUG-26");
  const [day, setDay] = useState("22");

  const handlePreview = async (e) => {
    e.preventDefault();
    if (!file) return alert("Please select a file first.");

    setLoading(true);
    setMessage("");
    setPreviewData(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileType", fileType);
    formData.append("action", "preview");

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        setPreviewData(data.summary);
      } else {
        setMessage(`Error: ${data.error}`);
      }
    } catch (err) {
      setMessage(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmUpload = async () => {
    setLoading(true);
    setMessage("");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileType", fileType);
    formData.append("action", "upload");

    if (fileType === "inventory") {
      formData.append("year", year);
      formData.append("month", month);
      formData.append("day", `DAY${day}`);
    }

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        setMessage(data.message);
        setPreviewData(null);
        setFile(null);
      } else {
        setMessage(`Error: ${data.error}`);
      }
    } catch (err) {
      setMessage(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto mt-10 bg-white border border-gray-100 rounded-2xl shadow-xl p-8 space-y-6">
      <div className="border-b pb-4">
        <h2 className="text-2xl font-extrabold text-gray-900 tracking-tight">
          Data Management & Upload
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Easily upload and merge your multi-day sales or daily inventory
          sheets.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1.5">
            Select File Type
          </label>
          <select
            value={fileType}
            onChange={(e) => {
              setFileType(e.target.value);
              setPreviewData(null);
            }}
            className="w-full bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-3 transition"
          >
            <option value="sale">
              Sale File (Multi-day with Month/Day columns)
            </option>
            <option value="inventory">
              Inventory File (Single day snapshot)
            </option>
          </select>
        </div>

        {fileType === "inventory" && (
          <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl space-y-3">
            <h4 className="text-xs font-bold text-blue-800 uppercase tracking-wide">
              Target Snapshot Date
            </h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-blue-700 mb-1">
                  Year
                </label>
                <input
                  type="text"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  className="w-full bg-white border border-blue-200 text-gray-800 text-sm rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-blue-700 mb-1">
                  Month
                </label>
                <input
                  type="text"
                  value={month}
                  onChange={(e) => setMonth(e.target.value.toUpperCase())}
                  className="w-full bg-white border border-blue-200 text-gray-800 text-sm rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  placeholder="AUG-26"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-blue-700 mb-1">
                  Day Number
                </label>
                <input
                  type="text"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  className="w-full bg-white border border-blue-200 text-gray-800 text-sm rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  placeholder="22"
                />
              </div>
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1.5">
            Choose Excel Document (.xlsx, .xls)
          </label>
          <input
            type="file"
            accept=".xlsx, .xls"
            onChange={(e) => setFile(e.target.files[0])}
            className="w-full text-sm text-gray-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer border border-gray-300 rounded-lg p-2 bg-gray-50"
          />
        </div>
      </div>

      {!previewData ? (
        <button
          onClick={fileType === "sale" ? handlePreview : handleConfirmUpload}
          disabled={loading || !file}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-xl shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading
            ? "Processing Document..."
            : fileType === "sale"
              ? "Preview File Structure"
              : "Upload Inventory Snapshot"}
        </button>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 p-5 rounded-2xl space-y-4">
          <div className="flex items-center space-x-2">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <h3 className="font-bold text-emerald-900 text-base">
              File Verified Successfully
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm bg-white/80 p-3 rounded-xl border border-emerald-100 text-gray-700">
            <p>
              Total Rows:{" "}
              <strong className="text-gray-900">{previewData.totalRows}</strong>
            </p>
            <p>
              Months:{" "}
              <strong className="text-gray-900">
                {previewData.months.join(", ")}
              </strong>
            </p>
            <p className="col-span-2">
              Span:{" "}
              <strong className="text-gray-900">
                {previewData.days.length} days
              </strong>{" "}
              (Day {previewData.days[0]} to{" "}
              {previewData.days[previewData.days.length - 1]})
            </p>
          </div>

          <div className="flex space-x-3 pt-1">
            <button
              onClick={handleConfirmUpload}
              disabled={loading}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2.5 px-4 rounded-xl shadow transition disabled:opacity-50"
            >
              {loading ? "Merging Data..." : "Confirm & Merge Upload"}
            </button>
            <button
              onClick={() => setPreviewData(null)}
              className="bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium px-4 py-2.5 rounded-xl transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <div
          className={`p-3 rounded-xl text-center text-sm font-medium ${message.includes("Error") ? "bg-red-50 text-red-700 border border-red-200" : "bg-blue-50 text-blue-700 border border-blue-200"}`}
        >
          {message}
        </div>
      )}
    </div>
  );
}
