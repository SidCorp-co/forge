// Days and weeks as a reader's calendar names them, `YYYY-MM-DD`: the one rule core's reads (the
// project home) and the web's overview bands count a day by, so a bar for "Nov 8" holds the same
// items wherever it is drawn. A week starts on Monday.

/** A day's key, `YYYY-MM-DD`, as a calendar in `tz` reads the instant. */
export function dayKeyIn(tz: string): (at: string | Date) => string {
	// en-CA writes a date as YYYY-MM-DD
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return (at) => fmt.format(typeof at === "string" ? new Date(at) : at);
}

/** The day `n` days after `key` (before, for a negative `n`). */
export function shiftDay(key: string, n: number): string {
	const [y, m, d] = key.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Monday of the week `key` falls in. */
export function weekOf(key: string): string {
	const [y, m, d] = key.split("-").map(Number) as [number, number, number];
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return shiftDay(key, -((weekday + 6) % 7));
}

/** The `n` days ending on `today`, oldest first. */
export const daysEnding = (today: string, n: number): string[] =>
	Array.from({ length: n }, (_, i) => shiftDay(today, i + 1 - n));

/** The Mondays of the `n` weeks ending with the week of `today`, oldest first. */
export const weeksEnding = (today: string, n: number): string[] =>
	Array.from({ length: n }, (_, i) =>
		shiftDay(weekOf(today), -7 * (n - 1 - i)),
	);
