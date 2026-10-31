// A hold's time as a sentence reads it, shared by every release-batch sentence that names one.

const MINUTE_MS = 60_000;

/**
 * A hold's time as the sentence around it reads (ISS-279): `16:23 UTC on 2026-10-06`, never the raw
 * ISO stamp the reading carries. It is rounded UP to the minute (ISS-278), so a next try at 16:23:59
 * reads 16:24 and the hold never outlasts the time it shows. A value that is not a time is kept as
 * written rather than read as one.
 */
export function atUtcMinute(stamp: string): string {
  const at = new Date(stamp).getTime();
  if (Number.isNaN(at)) return stamp;
  const iso = new Date(Math.ceil(at / MINUTE_MS) * MINUTE_MS).toISOString();
  return `${iso.slice(11, 16)} UTC on ${iso.slice(0, 10)}`;
}
