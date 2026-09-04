/**
 * Money formatting for the dashboard.
 *
 * Revenue spans nine digits — 1,542,854,825 across the estate down to a few
 * hundred for one product in one branch — and a card is not wide enough for the
 * full number at that scale. Up to six digits is shown in full, because that is
 * a figure people read exactly; beyond that it is abbreviated, because nobody
 * reads the ninth digit of a billion.
 */
export function formatAmount(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";

  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  // Below a million, exact: 999,999 fits and is worth reading precisely.
  if (abs < 1_000_000) return sign + Math.round(abs).toLocaleString();

  const [divisor, suffix] =
    abs >= 1_000_000_000_000
      ? [1_000_000_000_000, "T"]
      : abs >= 1_000_000_000
        ? [1_000_000_000, "B"]
        : [1_000_000, "M"];

  const scaled = abs / divisor;
  // Two significant decimals under 10, one above — so 1.54M and 154.3M are both
  // about the same width, rather than 1.5M sitting beside 154.28M.
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  // Trailing zeros dropped: 2.00M reads as false precision.
  const text = scaled.toFixed(decimals).replace(/\.?0+$/, "");
  return `${sign}${text}${suffix}`;
}

/** The unabbreviated figure, for a title attribute. */
export function exactAmount(value) {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "";
}
