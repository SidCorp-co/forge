export interface WeekWindow {
  from: Date;
  to: Date;
  /** `<from date>..<to date>`, the identifier every artifact of the week carries. */
  id: string;
}

const DAY_MS = 86_400_000;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** The ISO week before the one holding `now`. */
export function weekBefore(now: Date): WeekWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const thisMonday = new Date(today.getTime() - sinceMonday * DAY_MS);
  const from = new Date(thisMonday.getTime() - 7 * DAY_MS);
  return { from, to: thisMonday, id: `${isoDate(from)}..${isoDate(thisMonday)}` };
}
