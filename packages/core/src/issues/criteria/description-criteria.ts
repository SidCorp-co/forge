// ISS-1080 — criteria written only in an issue's description. epod ISS-97 was filed with its
// acceptance criteria under its description's Outcome, so core read 0 criteria; the run landed it,
// and once at `awaiting_release` the criteria were locked (`store.ts:applyCriteria`), so putting them
// on the record took a reopen round-trip. A filing or a lease-take is told so by name before
// anything locks; it is advice, never a refusal (owner 2026-11-05: teach, never block).

/**
 * The rule `criteria-list-in-description`: a heading naming criteria, followed (blank lines aside)
 * by a list. A heading is a markdown heading (`## Outcome`), a line that is one bold label
 * (`**Outcome:**`, `**Acceptance criteria**`) or a label alone on its line ending in a colon
 * (`Criteria:`). The labels are the ones a criteria list is filed under: `Acceptance criteria`,
 * `Criteria`, `Outcome` and `Done when`, and the issue-writing guide's own outcome block,
 * `What to do`. A list item is `-`, `*`, `+`, `1.` or `1)`, with or without a `[ ]` box.
 */
export const DESCRIPTION_CRITERIA_RULE = 'criteria-list-in-description';

const LABELS: ReadonlySet<string> = new Set([
  'acceptance criteria',
  'criteria',
  'outcome',
  'outcomes',
  'done when',
  'what to do',
]);

const ATX = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const BOLD = /^ {0,3}\*\*([^*]+?)\*\*\s*:?\s*$/u;
const COLON = /^ {0,3}([A-Za-z][A-Za-z ]*?)\s*:\s*$/u;
const ITEM = /^ {0,3}(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(\S.*)$/u;

export interface DescriptionCriteria {
  /** The heading the list stands under, as written. */
  readonly heading: string;
  /** Each list item's text, in order. */
  readonly items: readonly string[];
}

function labelOf(line: string): string | null {
  const m = ATX.exec(line) ?? BOLD.exec(line) ?? COLON.exec(line);
  if (!m) return null;
  const label = (m[1] as string).replace(/[:*]+$/u, '').trim();
  return LABELS.has(label.toLowerCase()) ? label : null;
}

/** The first criteria list the description holds under the rule above, or null. */
export function criteriaListOf(description: string | null | undefined): DescriptionCriteria | null {
  const lines = String(description ?? '').split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const heading = labelOf(lines[i] as string);
    if (heading === null) continue;
    let at = i + 1;
    while (at < lines.length && (lines[at] as string).trim() === '') at += 1;
    const items: string[] = [];
    for (; at < lines.length; at += 1) {
      const line = lines[at] as string;
      const item = ITEM.exec(line);
      // a blank line or an indented continuation stays in the list; any other line ends it
      if (item) items.push((item[1] as string).trim());
      else if (line.trim() !== '' && !/^\s{2,}\S/u.test(line)) break;
    }
    if (items.length > 0) return { heading, items };
  }
  return null;
}

/**
 * What a filing or a lease-take is told where the issue has no criteria on the record and its
 * description holds a criteria list; null where either is not so.
 */
export function unrecordedCriteriaWarning(issue: {
  id: string;
  description: string | null;
  liveCriteria: number;
}): string | null {
  if (issue.liveCriteria > 0) return null;
  const list = criteriaListOf(issue.description);
  if (!list) return null;
  const count = list.items.length === 1 ? '1 item' : `${list.items.length} items`;
  return (
    `${DESCRIPTION_CRITERIA_RULE}: the description lists ${count} under "${list.heading}", and this issue has 0 criteria on the record, ` +
    'so no verdict can attach to them, and they lock once the issue reaches `awaiting_release`. ' +
    `Record them now: \`PUT /api/issues/${issue.id}/criteria\` with \`{ "criteria": [{ "statement": "…" }] }\`; ` +
    'a filing takes them as `acceptanceCriteria`, numbered lines (`1. …`).'
  );
}
