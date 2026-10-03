/**
 * ISS-55 — numbered acceptance criteria as text, read into rows and rendered back.
 *
 * `issues.acceptance_criteria` stays the text a plan writes (forge-plugin 3.36.542 PATCHes it);
 * `issue_criteria` is what the gate and the UI read. Each write of the text is read here, and a PUT
 * of the rows renders the text from them, so the two never say different things. Pure: the deploy's
 * backfill (`db/criteria-backfill.ts`) imports it before any database client exists.
 */

/** A top-level numbered line: up to three leading spaces, a number, a dot, a space. */
const NUMBERED = /^ {0,3}(\d+)\.\s+(.*)$/u;

export interface ParsedCriterion {
  readonly n: number;
  readonly statement: string;
}

export interface CriteriaTextFault {
  readonly n: number | null;
  readonly why: string;
}

export interface ParsedCriteriaText {
  readonly criteria: readonly ParsedCriterion[];
  /** Why the text cannot be read as criteria; non-empty means `criteria` must not be written. */
  readonly faults: readonly CriteriaTextFault[];
  /** True where the text holds words but no numbered line at all. */
  readonly unnumbered: boolean;
}

/** Collapse runs of whitespace, so a re-wrapped line is the same criterion and not a reworded one. */
export function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/gu, ' ').trim();
}

/**
 * The numbered criteria a text holds, in the order written. A line under a numbered line belongs to
 * it; text before the first numbered line is a heading, not a criterion.
 */
export function parseCriteriaText(text: string | null | undefined): ParsedCriteriaText {
  const body = String(text ?? '');
  const open: Array<{ n: number; lines: string[] }> = [];
  for (const line of body.split(/\r?\n/u)) {
    const match = NUMBERED.exec(line);
    if (match) {
      open.push({ n: Number.parseInt(match[1] as string, 10), lines: [match[2] as string] });
      continue;
    }
    open.at(-1)?.lines.push(line.trim());
  }
  const faults: CriteriaTextFault[] = [];
  const seen = new Set<number>();
  const criteria: ParsedCriterion[] = [];
  for (const { n, lines } of open) {
    const statement = lines.join('\n').trim();
    if (n < 1) faults.push({ n, why: `criterion ${n} is numbered below 1` });
    else if (seen.has(n)) faults.push({ n, why: `criterion ${n} is numbered twice` });
    else if (statement === '') faults.push({ n, why: `criterion ${n} has no statement` });
    seen.add(n);
    criteria.push({ n, statement });
  }
  return {
    criteria: faults.length > 0 ? [] : criteria,
    faults,
    unnumbered: open.length === 0 && body.trim() !== '',
  };
}

/** The text a set of criteria renders to; continuation lines are indented so they never number. */
export function renderCriteriaText(criteria: readonly ParsedCriterion[]): string {
  return criteria
    .map(({ n, statement }) => {
      const [first, ...rest] = statement.split('\n');
      return [`${n}. ${first ?? ''}`, ...rest.map((line) => `    ${line}`)].join('\n');
    })
    .join('\n');
}
