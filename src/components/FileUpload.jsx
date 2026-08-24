"use client";

import { useState, useRef, useEffect } from "react";

export default function FileUpload() {
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState("sale");
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef(null);

  const [year, setYear] = useState("2026");
  const [month, setMonth] = useState("AUG-26");
  const [day, setDay] = useState("22");

  // Infinite/smooth indeterminate progress ticker until request resolves
  useEffect(() => {
    let timer;
    if (loading) {
      setProgress(10);
      timer = setInterval(() => {
        setProgress((oldProgress) => {
          if (oldProgress >= 95) return 95;
          const diff = 95 - oldProgress;
          const increment = Math.max(Math.floor(diff * 0.1), 1);
          return oldProgress + increment;
        });
      }, 200);
    } else {
      setProgress(100);
      timer = setTimeout(() => setProgress(0), 400);
    }
    return () => {
      clearInterval(timer);
      clearTimeout(timer);
    };
  }, [loading]);

  const handleFileChange = (selectedFile) => {
    if (selectedFile) {
      if (!selectedFile.name.match(/\.(xlsx|xls)$/i)) {
        alert("Please select a valid Excel file (.xlsx or .xls).");
        return;
      }
      setFile(selectedFile);
      setPreviewData(null);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

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
        setProgress(100);
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
        setProgress(100);
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
    <div className="relative max-w-xl mx-auto mt-10 p-8 space-y-6 rounded-[36px] bg-white/40 backdrop-blur-3xl border border-white/60 shadow-[0_30px_60px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] overflow-hidden">
      
      {/* Background Frosted Lighting Glow Effects */}
      <div className="absolute -top-24 -left-24 w-72 h-72 bg-blue-400/20 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-24 -right-24 w-72 h-72 bg-indigo-400/20 rounded-full blur-3xl pointer-events-none"></div>

      <div className="relative z-10 border-b border-white/40 pb-4">
        <h2 className="text-2xl font-extrabold text-gray-900 tracking-tight drop-shadow-sm">
          Data Management & Upload
        </h2>
        <p className="text-sm text-gray-600 mt-1 font-medium">
          Easily upload and merge your multi-day sales or daily inventory sheets.
        </p>
      </div>

      <div className="relative z-10 space-y-4">
        <div>
          <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">
            Select File Type
          </label>
          
          {/* Glassmorphic Radio Button / Selection Pills */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => {
                setFileType("sale");
                setPreviewData(null);
              }}
              className={`flex items-center space-x-3 p-3.5 rounded-2xl border text-left transition backdrop-blur-xl ${
                fileType === "sale"
                  ? "bg-blue-500/10 border-blue-500/50 shadow-[0_4px_20px_rgba(37,99,235,0.15)] text-blue-900"
                  : "bg-white/40 border-white/80 hover:bg-white/60 text-gray-700"
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full border flex items-center justify-center transition ${
                  fileType === "sale"
                    ? "border-blue-600 bg-blue-600 shadow-sm"
                    : "border-gray-300 bg-white/50"
                }`}
              >
                {fileType === "sale" && (
                  <div className="w-2 h-2 rounded-full bg-white"></div>
                )}
              </div>
              <div>
                <p className="text-xs font-bold leading-tight">Sale File</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Multi-day columns</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setFileType("inventory");
                setPreviewData(null);
              }}
              className={`flex items-center space-x-3 p-3.5 rounded-2xl border text-left transition backdrop-blur-xl ${
                fileType === "inventory"
                  ? "bg-blue-500/10 border-blue-500/50 shadow-[0_4px_20px_rgba(37,99,235,0.15)] text-blue-900"
                  : "bg-white/40 border-white/80 hover:bg-white/60 text-gray-700"
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full border flex items-center justify-center transition ${
                  fileType === "inventory"
                    ? "border-blue-600 bg-blue-600 shadow-sm"
                    : "border-gray-300 bg-white/50"
                }`}
              >
                {fileType === "inventory" && (
                  <div className="w-2 h-2 rounded-full bg-white"></div>
                )}
              </div>
              <div>
                <p className="text-xs font-bold leading-tight">Inventory File</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Single day snapshot</p>
              </div>
            </button>
          </div>
        </div>

        {fileType === "inventory" && (
          <div className="bg-white/40 backdrop-blur-xl border border-white/80 p-4 rounded-2xl space-y-3 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
            <h4 className="text-xs font-extrabold text-blue-900 uppercase tracking-wide">
              Target Snapshot Date
            </h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-blue-800 mb-1">
                  Year
                </label>
                <input
                  type="text"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  className="w-full bg-white/60 backdrop-blur-md border border-white/90 text-gray-800 text-sm rounded-xl p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400 shadow-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-blue-800 mb-1">
                  Month
                </label>
                <input
                  type="text"
                  value={month}
                  onChange={(e) => setMonth(e.target.value.toUpperCase())}
                  className="w-full bg-white/60 backdrop-blur-md border border-white/90 text-gray-800 text-sm rounded-xl p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400 shadow-sm"
                  placeholder="AUG-26"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-blue-800 mb-1">
                  Day Number
                </label>
                <input
                  type="text"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  className="w-full bg-white/60 backdrop-blur-md border border-white/90 text-gray-800 text-sm rounded-xl p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400 shadow-sm"
                  placeholder="22"
                />
              </div>
            </div>
          </div>
        )}

        {/* Ultra Glassmorphic Dropzone */}
        <div>
          <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
            Choose Excel Document (.xlsx, .xls)
          </label>

          <input
            type="file"
            ref={fileInputRef}
            accept=".xlsx, .xls"
            onChange={(e) => handleFileChange(e.target.files[0])}
            className="hidden"
          />

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-[28px] p-8 text-center cursor-pointer transition bg-white/30 backdrop-blur-xl flex flex-col items-center justify-center space-y-4 shadow-[inset_0_1px_3px_rgba(255,255,255,0.8)] ${
              isDragging
                ? "border-blue-500 bg-blue-50/40 shadow-[0_10px_30px_rgba(37,99,235,0.15)]"
                : "border-white/80 hover:border-white hover:bg-white/50"
            }`}
          >
            <div className="w-16 h-16 rounded-full bg-gradient-to-b from-white/90 to-blue-50/50 shadow-[0_10px_25px_rgba(0,102,255,0.2)] border border-white flex items-center justify-center text-blue-600 hover:scale-105 transition">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-7 h-7 drop-shadow-sm"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-bold text-gray-800 tracking-tight">
                Drop your Excel file here
              </p>
              <p className="text-xs text-gray-500 max-w-[280px] mx-auto leading-relaxed">
                For best results, Excel spreadsheet uploads should be valid <span className="font-semibold text-gray-700">.xlsx</span> or <span className="font-semibold text-gray-700">.xls</span> files.
              </p>
            </div>
          </div>
        </div>

        {/* Glass Frosted File Progress Card */}
        {file && (
          <div className="bg-white/50 backdrop-blur-2xl border border-white/80 shadow-[0_12px_35px_rgba(0,0,0,0.06)] rounded-2xl p-4 space-y-3 relative overflow-hidden">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-white/80 border border-white flex items-center justify-center text-blue-600 font-extrabold text-xs uppercase shadow-sm">
                  XLS
                </div>
                <div>
                  <h4 className="text-sm font-bold text-gray-900 truncate max-w-[240px]">
                    {file.name}
                  </h4>
                  <p className="text-xs text-gray-500 font-medium">
                    {loading ? `Processing...` : `${(file.size / 1024).toFixed(1)} KB`}
                  </p>
                </div>
              </div>

              {!loading && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                    setPreviewData(null);
                  }}
                  className="w-8 h-8 rounded-full bg-white/60 hover:bg-white text-gray-600 flex items-center justify-center transition shadow-sm"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Smooth Indeterminate Progress Bar */}
            <div className="w-full bg-white/40 h-2 rounded-full overflow-hidden p-0.5 border border-white/60">
              <div
                className={`bg-blue-600 h-full rounded-full transition-all duration-300 ease-out shadow-[0_0_15px_rgba(37,99,235,0.7)] ${
                  loading ? "animate-pulse" : ""
                }`}
                style={{ width: `${loading ? progress : file ? 100 : 0}%` }}
              ></div>
            </div>
          </div>
        )}
      </div>

      {!previewData ? (
        <button
          onClick={fileType === "sale" ? handlePreview : handleConfirmUpload}
          disabled={loading || !file}
          className="relative z-10 w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-3.5 px-4 rounded-2xl shadow-[0_10px_30px_rgba(37,99,235,0.35),inset_0_1px_0_rgba(255,255,255,0.3)] transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 border border-white/20"
        >
          {loading && (
            <svg className="animate-spin -ml-1 mr-3 h-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          )}
          <span>
            {loading
              ? "Processing Document..."
              : fileType === "sale"
              ? "Preview File Structure"
              : "Upload Inventory Snapshot"}
          </span>
        </button>
      ) : (
        <div className="relative z-10 bg-emerald-50/60 backdrop-blur-2xl border border-emerald-200/80 p-5 rounded-2xl space-y-4 shadow-[0_15px_35px_rgba(5,150,105,0.1)]">
          <div className="flex items-center space-x-2">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <h3 className="font-extrabold text-emerald-900 text-base">
              File Verified Successfully
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm bg-white/70 backdrop-blur-md p-3 rounded-xl border border-emerald-100/80 text-gray-700 shadow-sm">
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
              className="flex-1 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold py-2.5 px-4 rounded-xl shadow-[0_10px_20px_rgba(5,150,105,0.25)] transition disabled:opacity-50 border border-white/20"
            >
              {loading ? "Merging Data..." : "Confirm & Merge Upload"}
            </button>
            <button
              onClick={() => setPreviewData(null)}
              className="bg-white/60 hover:bg-white/80 text-gray-700 font-semibold px-4 py-2.5 rounded-xl transition backdrop-blur-md border border-white/80 shadow-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <div
          className={`relative z-10 p-3 rounded-xl text-center text-sm font-semibold backdrop-blur-xl border ${
            message.includes("Error")
              ? "bg-red-50/60 text-red-700 border-red-200/80 shadow-sm"
              : "bg-blue-50/60 text-blue-700 border-blue-200/80 shadow-sm"
          }`}
        >
          {message}
        </div>
      )}
    </div>
  );
}