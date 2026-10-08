// A record that dates itself: an agent's decision opens with a stamp such as
// `**Decision (master, 2026-10-08 23:00Z): …**`, and a stamp later than the moment the record was
// written is a time that had not come yet. Only a bracketed stamp on the first line is read, so a
// date the decision is about ("we launch on 2099-01-01") is never taken for one.

const FIRST_LINE_STAMP =
  /\([^()\n]*?\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?)?\b[^()\n]*\)/;

// a bare date or a time with no zone is read in the latest zone a writer may be in, UTC+14, so a
// local date or hour is never flagged for the zone it was written in
const LATEST_ZONE_MS = 14 * 3_600_000;
/** A stamp a few minutes ahead is clock skew, not a record dated ahead. */
const SKEW_MS = 5 * 60_000;

function zoneOffsetMs(zone: string): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!m) return 0;
  const ms = (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return m[1] === '+' ? ms : -ms;
}

/** The instant the first-line stamp states, when it is later than `writtenAt`; null otherwise. */
export function datedAhead(body: string, writtenAt: Date): string | null {
  const firstLine = body.split('\n', 1)[0] ?? '';
  const m = FIRST_LINE_STAMP.exec(firstLine);
  if (!m?.[1]) return null;
  const [, date, hh, mm, zone] = m;
  const utc = Date.parse(`${date}T${hh ?? '00'}:${mm ?? '00'}:00Z`);
  if (Number.isNaN(utc)) return null;
  const stated = zone ? utc - zoneOffsetMs(zone === 'Z' ? '+00:00' : zone) : utc;
  // a bare date reaches its earliest instant at the latest zone's midnight; an unzoned hour too
  const earliest = zone ? stated : stated - LATEST_ZONE_MS;
  return earliest > writtenAt.getTime() + SKEW_MS ? new Date(stated).toISOString() : null;
}
