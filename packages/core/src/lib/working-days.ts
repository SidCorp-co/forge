/** Working days are Monday to Friday in UTC; no holiday calendar is kept. */

const DAY_MS = 86_400_000;

const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** The instant `n` working days after `from`, keeping its time of day; a weekend start counts from the next Monday. */
export function addWorkingDays(from: Date, n: number): Date {
  let at = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    at = new Date(at.getTime() + DAY_MS);
    if (!isWeekend(at)) left -= 1;
  }
  while (isWeekend(at)) at = new Date(at.getTime() + DAY_MS);
  return at;
}
