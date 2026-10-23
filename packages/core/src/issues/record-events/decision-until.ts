// How a decision record's `until` field is read (ISS-607). It ends the decision on a date only where
// it names one unambiguously: an ISO 8601 date (`2026-11-01`, read as its start, 00:00 UTC) or a
// date-time carrying its zone (`2026-11-01T09:00Z`, `2026-11-01T09:00+07:00`). Any other text is a
// condition, which no clock ends: the decision holds until the item's standing moves. `Date.parse`
// is never asked to guess, since it reads many sentences as old dates ("the owner admits or drops
// ISS-304" as the year 303) and so expired a person's decision as it was written. The write is told
// how its `until` was read, so the reading is never a silent one.

export type DecisionUntil = { kind: 'date'; at: Date } | { kind: 'condition'; text: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/** Whether year, month and day name a day of the calendar: `Date.parse` rolls 02-30 into March. */
function isCalendarDay(year: string, month: string, day: string): boolean {
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    at.getUTCFullYear() === Number(year) &&
    at.getUTCMonth() === Number(month) - 1 &&
    at.getUTCDate() === Number(day)
  );
}

/** The `until` text read as a date where it names one unambiguously, else as a condition. */
export function readDecisionUntil(text: string): DecisionUntil {
  const value = text.trim();
  const parts = DATE.exec(value) ?? DATE_TIME.exec(value);
  if (parts && isCalendarDay(parts[1] as string, parts[2] as string, parts[3] as string)) {
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return { kind: 'date', at: new Date(at) };
  }
  return { kind: 'condition', text: value };
}

interface Field {
  readonly key: string;
  readonly value: string;
}

/**
 * What the writer of a decision is told about how its field `name`, holding `text`, was read: as a
 * condition, or as a date already passed at `now`, which answers nothing; a date still to come says
 * nothing. An issue's `decision` record names the field `until`; a feedback item's or a
 * requirement's decision comment names it `reversedWhen` (`comments/decision-answers.ts`).
 */
export function untilReadingWarnings(name: string, text: string, now: Date): string[] {
  const until = readDecisionUntil(text);
  if (until.kind === 'condition') {
    return [
      `DECISION_UNTIL_CONDITION: ${name} \`${until.text}\` is no ISO 8601 date (2026-11-01) or date-time with a zone (2026-11-01T09:00Z), so it is read as a condition: the decision holds until the item's standing moves, and no date ends it`,
    ];
  }
  if (until.at <= now) {
    return [
      `DECISION_UNTIL_PASSED: ${name} ${until.at.toISOString()} has already passed, so this decision answers no ask; send a date still to come, or a condition`,
    ];
  }
  return [];
}

/**
 * What the writer of a `decision` record is told about its `until`: read as a condition, or a date
 * already passed at `now`, which answers nothing. A date still to come, or no `until`, says nothing.
 */
export function decisionUntilWarnings(kind: string, fields: readonly Field[], now: Date): string[] {
  if (kind !== 'decision') return [];
  const field = fields.find((f) => f.key === 'until' && f.value.trim().length > 0);
  if (!field) return [];
  return untilReadingWarnings('until', field.value, now);
}
