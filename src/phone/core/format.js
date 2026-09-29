// Formatting shared by every screen: the iPhone app's PalmTime, PalmPath,
// PalmText and byte counts.

/** "now" for the last minute, then "5 min. ago", "2 hr. ago" (iOS's short style). */
export function relative(value) {
  const date = value ? new Date(value) : null;
  if (!date || isNaN(date)) return "";
  const seconds = (date.getTime() - Date.now()) / 1000;
  if (seconds > -60) return "now";
  const rtf = new Intl.RelativeTimeFormat("en", { style: "short", numeric: "always" });
  const abs = Math.abs(seconds);
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  if (abs < 30 * 86400) return rtf.format(Math.round(seconds / (7 * 86400)), "week");
  if (abs < 365 * 86400) return rtf.format(Math.round(seconds / (30 * 86400)), "month");
  return rtf.format(Math.round(seconds / (365 * 86400)), "year");
}

/** The Mac user's home folder reads as "~". */
export function displayPath(path, home) {
  if (!home || home === "/" || !path) return path || "";
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** A short version that ends on a whole word, with no "…". */
export function excerpt(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) return cut.slice(0, space).replace(/[ ,;:-]+$/, "");
  return cut;
}

/** ByteCountFormatter's .file style: "12 KB", "3.4 MB". */
export function bytes(n) {
  if (n === null || n === undefined || n < 0) return "";
  if (n < 1000) return `${n} byte${n === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

export const lastPathComponent = (path) => String(path || "").replace(/\/+$/, "").split("/").pop() || path;
