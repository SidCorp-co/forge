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
  const ms = Math.max(0, now.getTime() - at);
  if (ms < MINUTE_MS) return 'less than a minute';
  if (ms < HOUR_MS) return counted(Math.floor(ms / MINUTE_MS), 'minute');
  if (ms < DAY_MS) return counted(Math.floor(ms / HOUR_MS), 'hour');
  return counted(Math.floor(ms / DAY_MS), 'day');
}
