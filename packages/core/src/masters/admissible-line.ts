// The admissible issues a direct pass is asked to build, named on the pass itself (ISS-1224, extra
// fix). A direct pass is typed with the fixed order and what is owed; the admissible issues moved
// only the digest that decides whether to wake, so ISS-1224, created at `open` through the REST
// API, woke its master for five hours (07:09Z to 12:07Z on 2026-11-12) on passes that never said
// which issue. A dispatching pass reads the board by the dispatch method's wave and is left as it is.

/** The fields of an admissible issue the line names (`devices/admissible.ts:AdmissibleIssue`). */
export interface AdmissibleNamed {
  issueId: string;
  issueKey: string | null;
  priority: string | null;
}

/** How many a pass names by key; the rest are counted, never dropped in silence. */
const NAMED = 5;

/** The sentence naming the admissible issues in the order to take them; empty when there are none. */
export function admissibleLine(admissible: readonly AdmissibleNamed[]): string {
  if (admissible.length === 0) return '';
  const one = admissible.length === 1;
  const named = admissible
    .slice(0, NAMED)
    .map((a) => `${a.issueKey ?? a.issueId} ${a.issueId}${a.priority ? ` (${a.priority})` : ''}`);
  const more =
    admissible.length > NAMED ? `, and ${admissible.length - NAMED} more after them` : '';
  return ` ${admissible.length} admissible issue${one ? ' is' : 's are'} open for you to build, in the order to take ${one ? 'it' : 'them'}: ${named.join('; ')}${more}. Take ${one ? 'it' : 'them'} top-down into the batch, or record on the issue why you pass ${one ? 'it' : 'one'} over.`;
}
