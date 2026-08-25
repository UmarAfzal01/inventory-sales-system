"use client";

import { useState, useRef, useEffect } from "react";

export default function FileUpload({ isOpen, onClose }) {
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState("sale");
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef(null);

  // Inventory sheets carry no date columns, so the operator supplies one.
  // A single ISO date replaces the old Year / Month / Day text boxes, which the
  // server ignored entirely — every snapshot ended up filed under the same day.
  const [snapshotDate, setSnapshotDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [errors, setErrors] = useState([]);

  // Close modal on pressing ESC key — but not while a request is in flight, for
  // the same reason the close button is disabled: dismissing the dialog does not
  // cancel the upload, it just hides it.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, loading]);

  // Indeterminate progress ticker that runs until the request resolves.
  // The first value is set inside the timer rather than synchronously in the
  // effect body: a synchronous setState here triggers a cascading render, which
  // React's lint rules flag.
  useEffect(() => {
    if (loading) {
      const timer = setInterval(() => {
        setProgress((prev) => {
          if (prev === 0) return 10;
          if (prev >= 95) return 95;
          return prev + Math.max(Math.floor((95 - prev) * 0.1), 1);
        });
      }, 120);
      return () => clearInterval(timer);
    }

    const timer = setTimeout(() => setProgress(0), 400);
    return () => clearTimeout(timer);
  }, [loading]);

  if (!isOpen) return null;

  const handleFileChange = (selectedFile) => {
    if (selectedFile) {
      // A first-pass convenience check only — the server re-validates the file's
      // actual contents, since a rename defeats any check based on the name.
      if (!selectedFile.name.match(/\.(xlsx|xlsm|xls|csv)$/i)) {
        setErrors([`"${selectedFile.name}" is not a spreadsheet. Choose an .xlsx, .xls or .csv file.`]);
        return;
      }
      setErrors([]);
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
    setErrors([]);
    setPreviewData(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileType", fileType);
    formData.append("action", "preview");
    if (fileType === "inventory") formData.append("snapshotDate", snapshotDate);

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
        // Header validation returns a list; everything else a single message.
        setErrors(data.errors?.length ? data.errors : [data.error || "Could not read this file."]);
      }
    } catch (err) {
      setErrors([`Network error: ${err.message}`]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmUpload = async () => {
    setLoading(true);
    setMessage("");
    setErrors([]);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileType", fileType);
    formData.append("action", "upload");
    if (fileType === "inventory") formData.append("snapshotDate", snapshotDate);

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
        // The dashboard fetches its own data on the client, so nothing would
        // otherwise tell it new figures exist — you had to reload the page.
        // It listens for this and refetches in place.
        window.dispatchEvent(new CustomEvent("inventory:data-updated"));
      } else {
        setErrors(data.errors?.length ? data.errors : [data.error || "Upload failed."]);
      }
    } catch (err) {
      setErrors([`Network error: ${err.message}`]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md animate-in fade-in duration-200">
      {/* Modal Container - Pure White Theme */}
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto p-8 space-y-6 rounded-[36px] bg-white border border-slate-100 shadow-[0_25px_50px_rgba(0,0,0,0.1)]">
        
        {/* Close Widget Button. Disabled mid-request: closing the dialog does not
            cancel the upload, so letting it close mid-write hides an operation
            that is still running against the database. */}
        <button
          onClick={onClose}
          disabled={loading}
          title={loading ? "Please wait until the upload finishes" : "Close"}
          className="absolute top-6 right-6 w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 text-gray-700 flex items-center justify-center transition shadow-xs z-20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-100"
        >
          ✕
        </button>

        <div className="relative z-10 border-b border-slate-100 pb-4 pr-8">
          <h2 className="text-2xl font-extrabold text-gray-900 tracking-tight">
            Data Management & Upload
          </h2>
          <p className="text-sm text-gray-500 mt-1 font-medium">
            Easily upload and merge your multi-day sales or daily inventory sheets.
          </p>
        </div>

        <div className="relative z-10 space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">
              Select File Type
            </label>
            
            {/* Selection Pills */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setFileType("sale");
                  setPreviewData(null);
                }}
                className={`flex items-center space-x-3 p-3.5 rounded-2xl border text-left transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  fileType === "sale"
                    ? "bg-blue-50 border-blue-200 shadow-xs text-blue-900"
                    : "bg-slate-50/60 border-slate-200 hover:bg-slate-100/80 text-gray-700"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full border flex items-center justify-center transition ${
                    fileType === "sale"
                      ? "border-blue-600 bg-blue-600 shadow-xs"
                      : "border-gray-300 bg-white"
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
                disabled={loading}
                onClick={() => {
                  setFileType("inventory");
                  setPreviewData(null);
                }}
                className={`flex items-center space-x-3 p-3.5 rounded-2xl border text-left transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  fileType === "inventory"
                    ? "bg-blue-50 border-blue-200 shadow-xs text-blue-900"
                    : "bg-slate-50/60 border-slate-200 hover:bg-slate-100/80 text-gray-700"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full border flex items-center justify-center transition ${
                    fileType === "inventory"
                      ? "border-blue-600 bg-blue-600 shadow-xs"
                      : "border-gray-300 bg-white"
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
            <div className="bg-slate-50 border border-slate-200/80 p-4 rounded-2xl space-y-3">
              <h4 className="text-xs font-extrabold text-blue-900 uppercase tracking-wide">
                Stock Count Date
              </h4>
              <div>
                <input
                  id="snapshotDate"
                  type="date"
                  disabled={loading}
                  value={snapshotDate}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => {
                    setSnapshotDate(e.target.value);
                    setPreviewData(null);
                  }}
                  className="w-full sm:w-60 bg-white border border-slate-200 text-gray-800 text-sm rounded-xl p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <p className="text-[11px] text-gray-500 mt-2">
                  Inventory sheets have no date columns, so this is the day the stock was
                  counted. It becomes the snapshot&apos;s effective date.
                </p>
              </div>
            </div>
          )}

          {/* Clean Dropzone */}
          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
              Choose Excel Document (.xlsx, .xls)
            </label>

            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx,.xlsm,.xls,.csv"
              disabled={loading}
              onChange={(e) => handleFileChange(e.target.files[0])}
              className="hidden"
            />

            <div
              onDragOver={loading ? undefined : handleDragOver}
              onDragLeave={loading ? undefined : handleDragLeave}
              onDrop={loading ? (e) => e.preventDefault() : handleDrop}
              onClick={loading ? undefined : () => fileInputRef.current?.click()}
              aria-disabled={loading}
              className={`border-2 border-dashed rounded-[28px] p-8 text-center cursor-pointer transition bg-slate-50/50 flex flex-col items-center justify-center space-y-4 ${
                isDragging
                  ? "border-blue-500 bg-blue-50/50"
                  : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <div className="w-16 h-16 rounded-full bg-white shadow-sm border border-slate-100 flex items-center justify-center text-blue-600 transition">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-7 h-7"
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

          {/* File Progress Card */}
          {file && (
            <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 space-y-3 relative overflow-hidden">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-blue-600 font-extrabold text-xs uppercase shadow-xs">
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
                    className="w-8 h-8 rounded-full bg-white hover:bg-slate-100 text-gray-600 flex items-center justify-center transition border border-slate-200 shadow-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden p-0.5">
                <div
                  className={`bg-blue-600 h-full rounded-full transition-all duration-300 ease-out ${
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
            className="relative z-10 w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3.5 px-4 rounded-2xl shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 cursor-pointer"
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
          <div className="relative z-10 bg-emerald-50 border border-emerald-200 p-5 rounded-2xl space-y-4">
            <div className="flex items-center space-x-2">
              <span className="flex h-3 w-3 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <h3 className="font-extrabold text-emerald-900 text-base">
                File Verified Successfully
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm bg-white p-3 rounded-xl border border-emerald-100 text-gray-700 shadow-xs">
              <p>
                Rows:{" "}
                <strong className="text-gray-900">
                  {previewData.usableRows.toLocaleString()} of{" "}
                  {previewData.totalRows.toLocaleString()}
                </strong>
              </p>
              <p>
                Values:{" "}
                <strong className="text-gray-900">
                  {previewData.cells.toLocaleString()}
                </strong>
              </p>
              <p>
                Branches:{" "}
                <strong className="text-gray-900">
                  {previewData.branchColumns.length}
                </strong>
              </p>
              <p>
                {previewData.dates.length > 1 ? "Dates" : "Date"}:{" "}
                <strong className="text-gray-900">
                  {previewData.dates.length > 2
                    ? `${previewData.dates[0]} → ${previewData.dates[previewData.dates.length - 1]}`
                    : previewData.dates.join(", ") || "—"}
                </strong>
              </p>
              <p className="col-span-2 text-xs text-gray-500">
                {previewData.branchColumns.join(", ")}
              </p>
            </div>

            {previewData.alreadyUploaded && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
                This exact file was already uploaded on{" "}
                {new Date(previewData.alreadyUploaded.at).toLocaleString()}. Uploading it
                again will be rejected.
              </div>
            )}

            {previewData.warnings?.length > 0 && (
              <ul className="list-disc list-inside text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
                {previewData.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="flex space-x-3 pt-1">
              <button
                onClick={handleConfirmUpload}
                disabled={loading}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 px-4 rounded-xl transition disabled:opacity-50 cursor-pointer shadow-xs"
              >
                {loading ? "Merging Data..." : "Confirm & Merge Upload"}
              </button>
              <button
                disabled={loading}
                onClick={() => setPreviewData(null)}
                className="bg-white hover:bg-slate-100 text-gray-700 font-semibold px-4 py-2.5 rounded-xl transition border border-slate-200 shadow-xs cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {errors.length > 0 && (
          <div className="relative z-10 bg-red-50 border border-red-200 rounded-xl p-4 space-y-1.5">
            <h3 className="text-sm font-bold text-red-900">
              This file can&apos;t be uploaded
            </h3>
            <ul className="list-disc list-inside text-sm text-red-800 space-y-1">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {message && (
          <div className="relative z-10 p-3 rounded-xl text-center text-sm font-semibold border bg-blue-50 text-blue-700 border-blue-200">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}