// The wall clock in a time zone, read once for the runner's usage-limit reset (`runners/limit-detect.ts`)
// and a project's morning reminder (`support/wait-reminder-waits.ts`) alike.

/** The wall clock in `tz` at `at`; throws on an unknown zone. */
export function zonedClock(
  tz: string,
  at: Date,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const part = (type: string) => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`zonedClock: ${tz} formats no ${type} part`);
    return Number.parseInt(value, 10);
  };
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour') === 24 ? 0 : part('hour'),
    minute: part('minute'),
  };
}
