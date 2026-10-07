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

/** `14:05:09`: the clock time of an instant, to the second. */
export function formatClockSeconds(at: string | number | Date, language: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(copyLocale(language), { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at));
}

/** `1,2k`: a count shortened to thousands or millions, one decimal, in the language's digits. */
export function formatCompact(n: number, language: string): string {
  const one = (v: number) => new Intl.NumberFormat(copyLocale(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
  if (n >= 1_000_000) return `${one(n / 1_000_000)}M`;
  if (n >= 1_000) return `${one(n / 1_000)}k`;
  return formatNumber(n, language);
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

/** `42s`, `3m`, `4h`, `2d` and their Vietnamese reading: a span already measured, so a caller holding one instant grades every row against it. */
export function formatElapsed(ms: number, language: string): string {
  const t = productCopy(language);
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("common.age.seconds", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("common.age.minutes", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("common.age.hours", { n: h });
  return t("common.age.days", { n: Math.floor(h / 24) });
}

/** `in 5 min`, `in 3h`, `in 2 days` and their Vietnamese reading: how long until an instant; empty when none is known. */
export function formatCountdown(iso: string | null | undefined, language: string, now: number = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return "";
  const t = productCopy(language);
  if (ms <= 0) return t("common.countdown.now");
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return t("common.countdown.minutes", { n: Math.max(1, Math.round(ms / 60_000)) });
  if (hours < 48) return t("common.countdown.hours", { n: hours });
  return t("common.countdown.days", { n: Math.ceil(ms / 86_400_000) });
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
