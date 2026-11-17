const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });
const dtf = new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "medium" });
const nf = new Intl.NumberFormat("ja");

export function relativeTime(ms: number, now = Date.now()): string {
  const sec = Math.round((ms - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(sec, "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86400), "day");
}

export function dateTime(ms: number): string {
  return dtf.format(ms);
}

export function count(n: number): string {
  return nf.format(n);
}

export const STATUS_LABEL = {
  unresolved: "未解決",
  resolved: "解決済み",
  ignored: "無視",
} as const;
