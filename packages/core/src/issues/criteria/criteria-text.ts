// ISS-55 — numbered acceptance criteria as text, read into `issue_criteria` rows on every write of
// the text, and rendered back from the rows on a PUT, so the two never say different things.

const NUMBERED = /^ {0,3}(\d+)\.\s+(.*)$/u;

export interface ParsedCriterion {
  readonly n: number;
  readonly statement: string;
}

interface CriteriaTextFault {
  readonly n: number | null;
  readonly why: string;
}

interface ParsedCriteriaText {
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

/** The numbered criteria a text holds, in order; lines under a number belong to it. */
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

/**
 * The business criterion a criterion's own words say it proves: a lead `(REQ-<n> BC-<m>)`, the trace
 * a plan writes into the text path, which carries no `requirementCriterionId`. `none` where the
 * statement opens with no tag; `malformed` where it opens with `(REQ-` in any other shape — two
 * codes in one tag among them, since one criterion proves one BC (`issue_criteria.requirement_criterion_id`).
 */
export type TraceTag =
  | { kind: 'none' }
  | { kind: 'tag'; requirementSeq: number; code: string }
  | { kind: 'malformed'; tag: string };

const TRACE_TAG = /^\s*\(REQ-(\d+) (BC-\d+)\)/u;
const TAG_OPEN = /^\s*\(REQ-[^)]*\)?/u;

export function traceTagOf(statement: string): TraceTag {
  const m = TRACE_TAG.exec(statement);
  if (m) return { kind: 'tag', requirementSeq: Number(m[1]), code: m[2] as string };
  const open = TAG_OPEN.exec(statement);
  return open ? { kind: 'malformed', tag: open[0].trim() } : { kind: 'none' };
}

export const TRACE_TAG_SHAPE =
  '`(REQ-<n> BC-<m>) <statement>`: one requirement and one of its business criteria per criterion';
