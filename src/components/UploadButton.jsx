"use client";

export default function UploadButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      title="Upload Excel Data"
      className="group relative flex items-center justify-center w-12 h-12 rounded-full bg-white/40 hover:bg-white/70 backdrop-blur-2xl border border-white/80 shadow-[0_8px_30px_rgba(0,0,0,0.06)] hover:shadow-[0_8px_25px_rgba(37,99,235,0.25)] hover:scale-105 active:scale-95 transition-all duration-300 ease-out"
    >
      {/* Soft Ambient Inner Glow */}
      <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-blue-500/10 to-indigo-500/20 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>

      {/* Upload Icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="w-5 h-5 text-blue-600 group-hover:text-blue-700 transition-colors drop-shadow-sm"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
        />
      </svg>

      {/* Optional Tooltip on Hover */}
      <span className="absolute right-14 px-3 py-1 bg-slate-900/80 backdrop-blur-md text-white text-[11px] font-semibold rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-md">
        Upload Excel
      </span>
    </button>
  );
}