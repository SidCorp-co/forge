import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";

// A schedule's cron read as a cadence a person says aloud (ISS-1072): every N minutes, hourly, daily,
// weekdays or one weekday at a time. A cron no phrase fits reads as "Custom"; the cron itself stays in
// the row's tooltip and on the schedule's own page, never as the row's text.

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const NUMBER = /^\d+$/;

const at = (minute: string, hour: string) => `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

/** `cron` (five fields) as words; "Custom" where none of the plain cadences fits. */
export function cadenceOf(cron: string, t: Copy): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return t("schedules.cadence.custom");
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];
  const everyDay = dom === "*" && month === "*";
  if (!everyDay) return t("schedules.cadence.custom");
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === "*" && dow === "*") return t("schedules.cadence.everyMinutes", { n: Number(step[1]) });
  if (!NUMBER.test(minute)) return t("schedules.cadence.custom");
  if (hour === "*" && dow === "*") return t("schedules.cadence.hourly");
  if (!NUMBER.test(hour)) return t("schedules.cadence.custom");
  const time = at(minute, hour);
  if (dow === "*") return t("schedules.cadence.daily", { at: time });
  if (dow === "1-5") return t("schedules.cadence.weekdays", { at: time });
  const day = NUMBER.test(dow) ? DAYS[Number(dow) % 7] : undefined;
  return day ? t(`schedules.cadence.day.${day}` as ProductCopyKey, { at: time }) : t("schedules.cadence.custom");
}
