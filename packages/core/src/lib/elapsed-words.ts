const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function counted(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** How long ago `since` was, as a notice says it ("5 hours"): the server knows no reader's
 *  timezone, so a notice says how long rather than printing a stored timestamp. */
export function elapsedWords(since: Date | string, now: Date): string {
  const at = since instanceof Date ? since.getTime() : Date.parse(since);
  if (Number.isNaN(at)) throw new Error(`elapsedWords: "${String(since)}" is not a time`);
  return durationWords(now.getTime() - at);
}

export function durationWords(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE_MS) return 'less than a minute';
  if (span < HOUR_MS) return counted(Math.floor(span / MINUTE_MS), 'minute');
  if (span < DAY_MS) return counted(Math.floor(span / HOUR_MS), 'hour');
  return counted(Math.floor(span / DAY_MS), 'day');
}

/** "21 October 2026, 14:53 UTC": a moment as a person reads it, never an ISO stamp. */
export function utcMomentWords(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'a time that could not be read';
  const day = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${day}, ${time} UTC`;
}
