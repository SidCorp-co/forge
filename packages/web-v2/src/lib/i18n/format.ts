import { copyLocale, productCopy } from "./product-copy";

// Dates, times and numbers in the interface language: 24-hour clocks, day before month, the
// language's own digit grouping. One place, so a screen never picks a locale of its own.

const DATE_TIME: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** `03/10/2026, 14:05`: the date and time of an instant. */
export function formatDateTime(at: string | number | Date, language: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(copyLocale(language), { ...DATE_TIME, timeZone }).format(new Date(at));
}

/** `03/10/2026`: the date of an instant. */
export function formatDate(at: string | number | Date, language: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(copyLocale(language), { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(at));
}

/** `03/10`: day and month. */
export function formatDayMonth(at: string | number | Date, language: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(copyLocale(language), { day: "2-digit", month: "2-digit", timeZone }).format(new Date(at));
}

/** `14:05`: the clock time of an instant. */
export function formatClock(at: string | number | Date, language: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(copyLocale(language), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at));
}

/** `1.234` in vi, `1,234` in en. */
export function formatNumber(n: number, language: string): string {
  return new Intl.NumberFormat(copyLocale(language)).format(n);
}

/** `5 min ago` and its Vietnamese reading: the age of an instant; an empty or unreadable one reads as an empty string. */
export function formatRelative(iso: string | null | undefined, language: string, now: number = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const t = productCopy(language);
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return t("time.secondsAgo", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.floor(h / 24) });
}

/** `5m`, `3h`, `2d`, `4w` and their Vietnamese reading: the compact age a list's age column shows. */
export function formatAge(iso: string | null | undefined, language: string, now: number = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const t = productCopy(language);
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return t("common.age.now");
  if (s < 3600) return t("common.age.minutes", { n: Math.floor(s / 60) });
  if (s < 86_400) return t("common.age.hours", { n: Math.floor(s / 3600) });
  if (s < 86_400 * 14) return t("common.age.days", { n: Math.floor(s / 86_400) });
  return t("common.age.weeks", { n: Math.floor(s / (86_400 * 7)) });
}
