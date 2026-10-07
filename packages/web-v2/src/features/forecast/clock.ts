import { ETA_COPY, type EtaLang } from "./eta-copy";

// Clock times and day words in the viewer's timezone, for the ETA column and every forecast sentence:
// a time the reader can act on, never a duration they have to add to now.

export interface EtaClock {
  lang: EtaLang;
  now: number;
  /** The viewer's timezone where unset. */
  timeZone?: string | undefined;
}

const DAY_MS = 86_400_000;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface Parts {
  y: number;
  m: number;
  d: number;
  weekday: number;
  hh: string;
  mm: string;
}

const formats = new Map<string, Intl.DateTimeFormat>();

const formatOf = (timeZone: string | undefined) => {
  const key = timeZone ?? "";
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formats.set(key, f);
  }
  return f;
};

export function partsOf(ms: number, timeZone: string | undefined): Parts {
  const f = formatOf(timeZone);
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    weekday: WEEKDAY_INDEX[p.weekday ?? "Sun"] ?? 0,
    hh: (p.hour ?? "00").padStart(2, "0"),
    mm: (p.minute ?? "00").padStart(2, "0"),
  };
}

/** Calendar days from `now` to `ms` in the timezone: 0 today, 1 tomorrow, -1 yesterday. */
function dayOffset(ms: number, c: EtaClock): number {
  const a = partsOf(c.now, c.timeZone);
  const b = partsOf(ms, c.timeZone);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/**
 * When, as a cell reads it: "14:10" today, "Tomorrow 18:50", "Thu 09:00" within the week, the
 * date beyond it or already past. `inline` is the rail's mid-sentence form: "14:10 today", "tomorrow 18:50".
 */
export function whenText(iso: string, c: EtaClock, inline = false): string {
  const copy = ETA_COPY[c.lang];
  const ms = Date.parse(iso);
  const p = partsOf(ms, c.timeZone);
  const clock = `${p.hh}:${p.mm}`;
  const off = dayOffset(ms, c);
  if (off === 0) return inline ? `${clock} ${copy.todayInline}` : clock;
  if (off === 1) return `${inline ? copy.tomorrowInline : copy.tomorrow} ${clock}`;
  if (off > 1 && off < 7) return `${copy.weekdays[p.weekday]} ${clock}`;
  return copy.date(p.d, p.m);
}

/** The day something already happened: "Today", "Yesterday", else its date. */
export function doneDayText(iso: string, c: EtaClock): string {
  const copy = ETA_COPY[c.lang];
  const ms = Date.parse(iso);
  const off = dayOffset(ms, c);
  if (off === 0) return copy.today;
  if (off === -1) return copy.yesterday;
  const p = partsOf(ms, c.timeZone);
  return copy.date(p.d, p.m);
}

/**
 * A p50–p85 range as clock times, the day said once where both fall on it: "14:10 – 18:50 today",
 * "tomorrow 09:00 – 13:00", else each bound in full: "14:10 today – tomorrow 18:50".
 */
export function rangeText(p50At: string, p85At: string, c: EtaClock): string {
  const copy = ETA_COPY[c.lang];
  const lo = Date.parse(p50At);
  const hi = Math.max(lo, Date.parse(p85At));
  const a = partsOf(lo, c.timeZone);
  const b = partsOf(hi, c.timeZone);
  const offA = dayOffset(lo, c);
  if (offA === dayOffset(hi, c)) {
    const clocks = `${a.hh}:${a.mm} – ${b.hh}:${b.mm}`;
    if (offA === 0) return `${clocks} ${copy.todayInline}`;
    if (offA === 1) return `${copy.tomorrowInline} ${clocks}`;
    if (offA > 1 && offA < 7) return `${copy.weekdays[a.weekday]} ${clocks}`;
  }
  return `${whenText(p50At, c, true)} – ${whenText(p85At, c, true)}`;
}
