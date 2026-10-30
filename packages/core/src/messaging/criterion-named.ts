// A verdict names its criterion by number. A writer that sends the criterion's own line instead
// (`(REQ-8 BC-1) A reload shows every saved card`, as forge-plugin's `forge record verdict` does
// where the line opens with a trace tag) names it just as surely, so that exact line resolves to its
// number (adminhub-fe FB-364, adminhub-api ISS-83 and ISS-84, 2026-10-30). Exact only: the line as
// the issue holds it, with or without its leading `n. ` and its trace tag, its whitespace collapsed
// as a criterion's own identity collapses it (`criteria-text.ts:normalizeStatement`). Anything else
// is refused by name with the issue's criteria listed; nothing is guessed.

import type { ForgeRecord } from './forge-record.js';

/** One live criterion of the issue: its number, its statement, and the BC it traces, if any. */
export interface NamedCriterion {
  readonly n: number;
  readonly statement: string;
  /** `REQ-<n> BC-<m>` the criterion is traced to, or null where it traces none. */
  readonly trace: string | null;
}

export type CriterionNaming = { readonly n: number } | { readonly why: string };

const WHOLE_NUMBER = /^\d+$/u;
const NUMBERED = /^(\d+)\.\s+/u;
const LEAD_TAG = /^\((REQ-\d+ BC-\d+)\)\s*/u;

const squash = (text: string) => text.replace(/\s+/gu, ' ').trim();

function withoutTag(text: string): { tag: string | null; body: string } {
  const m = LEAD_TAG.exec(text);
  return m
    ? { tag: m[1] as string, body: text.slice(m[0].length).trim() }
    : { tag: null, body: text };
}

const clip = (text: string, at: number) => (text.length > at ? `${text.slice(0, at - 1)}…` : text);

/** Whether a `criterion` value names the criterion by its number, which needs no matching. */
export function isCriterionNumber(value: string): boolean {
  return WHOLE_NUMBER.test(value.trim());
}

/** The criterion `text` is the exact line of, or why it names none. */
export function criterionNamed(text: string, criteria: readonly NamedCriterion[]): CriterionNaming {
  let rest = squash(text);
  let number: number | null = null;
  const numbered = NUMBERED.exec(rest);
  if (numbered) {
    number = Number(numbered[1]);
    rest = rest.slice(numbered[0].length);
  }
  const given = withoutTag(rest);
  const matched = criteria.filter((c) => {
    const own = withoutTag(squash(c.statement));
    const trace = own.tag ?? c.trace;
    return (
      given.body !== '' &&
      given.body === own.body &&
      (number === null || number === c.n) &&
      (given.tag === null || given.tag === trace)
    );
  });
  const [only] = matched;
  if (only && matched.length === 1) return { n: only.n };
  const quoted = `\`${clip(squash(text), 80)}\``;
  if (matched.length > 1) {
    return {
      why: `${quoted} is the line of criteria ${matched.map((c) => c.n).join(' and ')} alike; name the one judged by its number.`,
    };
  }
  const listed = [...criteria]
    .sort((a, b) => a.n - b.n)
    .map((c) => `${c.n} "${clip(withoutTag(squash(c.statement)).body, 60)}"`);
  return {
    why: `${quoted} is not a criterion number, nor the exact line of one of this issue's criteria (its number and trace tag may be left off); ${
      listed.length === 0
        ? 'this issue has no criteria yet'
        : `its criteria are ${listed.join(', ')}`
    }. Name the one judged by its number.`,
  };
}

/** The record with every `criterion` line that is one criterion's exact line rewritten to its number. */
export function numberCriteria(
  record: ForgeRecord,
  criteria: readonly NamedCriterion[],
): ForgeRecord {
  if (record.kind !== 'verdict') return record;
  let changed = false;
  const fields = record.fields.map((field) => {
    const value = field.value.trim();
    if (field.key !== 'criterion' || value === '' || isCriterionNumber(value)) return field;
    const named = criterionNamed(value, criteria);
    if (!('n' in named)) return field;
    changed = true;
    return { ...field, value: String(named.n) };
  });
  return changed ? { ...record, fields } : record;
}
