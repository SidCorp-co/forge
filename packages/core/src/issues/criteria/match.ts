// ISS-567 — which live criterion row each criterion of a whole write is, matched by its wording
// before its number, so a criterion that only moved keeps its row, its trace and its verdicts.

import { normalizeStatement } from './criteria-text.js';

interface MatchRow {
  readonly n: number;
  readonly statement: string;
}

interface MatchInput {
  readonly n: number;
  readonly statement: string;
}

/** A wording repeated on the issue that would have to move: the live numbers and the new ones. */
export interface AmbiguousMove {
  readonly statement: string;
  readonly live: readonly number[];
  readonly desired: readonly number[];
}

export interface CriteriaMatch<R extends MatchRow> {
  /** The live row each desired criterion keeps, by its index in the write; absent means a new row. */
  readonly kept: ReadonlyMap<number, R>;
  /** Live rows no desired criterion keeps: reworded or removed, so retired. */
  readonly retired: readonly R[];
  /** Where non-empty the write cannot be mapped and must be refused; `kept` is then not to be used. */
  readonly ambiguous: readonly AmbiguousMove[];
}

function countBy(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

/**
 * Match `desired` to `live`:
 * 1. same number and same wording keeps the row;
 * 2. of the rest, a wording held by exactly one live row and one desired criterion, and repeated
 *    nowhere on either side, keeps the row at its new number (a swap is two such moves);
 * 3. a repeated wording is kept only at its own numbers — where any of it is left on both sides,
 *    which row keeps the verdicts cannot be told, and it is reported in `ambiguous`, never guessed.
 * Wording compares after whitespace is collapsed (`normalizeStatement`), as a re-wrap is no reword.
 */
export function matchCriteria<R extends MatchRow>(
  live: readonly R[],
  desired: readonly MatchInput[],
): CriteriaMatch<R> {
  const liveWords = live.map((r) => normalizeStatement(r.statement));
  const desiredWords = desired.map((c) => normalizeStatement(c.statement));
  const kept = new Map<number, R>();
  const taken = new Set<number>();
  desired.forEach((c, i) => {
    const at = live.findIndex(
      (r, j) => !taken.has(j) && r.n === c.n && liveWords[j] === desiredWords[i],
    );
    if (at === -1) return;
    taken.add(at);
    kept.set(i, live[at] as R);
  });

  const liveCount = countBy(liveWords);
  const desiredCount = countBy(desiredWords);
  const leftLive = new Map<string, number[]>();
  live.forEach((_, j) => {
    if (taken.has(j)) return;
    const w = liveWords[j] as string;
    leftLive.set(w, [...(leftLive.get(w) ?? []), j]);
  });
  const leftDesired = new Map<string, number[]>();
  desired.forEach((_, i) => {
    if (kept.has(i)) return;
    const w = desiredWords[i] as string;
    leftDesired.set(w, [...(leftDesired.get(w) ?? []), i]);
  });

  const ambiguous: AmbiguousMove[] = [];
  for (const [word, wanted] of leftDesired) {
    const rows = leftLive.get(word);
    if (!rows) continue;
    const repeated = (liveCount.get(word) ?? 0) > 1 || (desiredCount.get(word) ?? 0) > 1;
    if (!repeated && rows.length === 1 && wanted.length === 1) {
      taken.add(rows[0] as number);
      kept.set(wanted[0] as number, live[rows[0] as number] as R);
      continue;
    }
    ambiguous.push({
      statement: word,
      live: rows.map((j) => (live[j] as R).n),
      desired: wanted.map((i) => (desired[i] as MatchInput).n),
    });
  }
  return { kept, retired: live.filter((_, j) => !taken.has(j)), ambiguous };
}

/** Whether a desired set says the same thing as the live rows: same numbers, same statements. */
export function sameCriteria(live: readonly MatchRow[], desired: readonly MatchInput[]): boolean {
  if (live.length !== desired.length) return false;
  const byN = new Map(live.map((row) => [row.n, normalizeStatement(row.statement)]));
  return desired.every((c) => byN.get(c.n) === normalizeStatement(c.statement));
}

/**
 * A trace a write would drop: the live criterion that held it and the BC, or `n: null` where the BC
 * is left on fewer lines and every line that held it is still at a number carrying it, so which one
 * lost it cannot be told.
 */
export interface DroppedTrace {
  readonly n: number | null;
  readonly code: string;
}

/**
 * The traced lines a write rewords or removes without restating their trace, line by line: a reworded
 * line is a new criterion (`matchCriteria` keeps a row only for an unchanged wording), so a write
 * that does not restate the trace drops that line's proof silently (HOP ISS-39, whose 2026-10-06
 * rewrite left REQ-25 BC-1, BC-2 and BC-7 with no issue; catalog-api ISS-3, whose reworded line lost
 * BC-3 while another line still traced it). Lines are counted per BC by `codeOf` (a wording id to
 * its `REQ-n BC-m`, absent for one that is no proof to lose), so a trace kept at another wording of
 * the same BC, or by a line that only moved, drops nothing. Of a BC left on fewer lines, the lines
 * named are the ones that held it and whose number carries it no more, so a line already restating it
 * is never named and opening each named line with its tag is a write that is taken (ISS-673, K65).
 * Where every desired criterion states its trace (`requirementCriterionId` given, `null` meaning none)
 * the writer said so and nothing is refused.
 */
export function droppedTraces(
  live: readonly (MatchRow & { readonly requirementCriterionId: string | null })[],
  desired: readonly (MatchInput & {
    readonly requirementCriterionId?: string | null | undefined;
  })[],
  codeOf: ReadonlyMap<string, string>,
): DroppedTrace[] {
  if (desired.every((c) => c.requirementCriterionId !== undefined)) return [];
  const { kept } = matchCriteria(live, desired);
  const keptRows = new Set([...kept.values()]);
  const carriers = new Map<string, Set<number>>();
  for (const [i, c] of desired.entries()) {
    const id =
      c.requirementCriterionId === undefined
        ? kept.get(i)?.requirementCriterionId
        : c.requirementCriterionId;
    const code = id ? codeOf.get(id) : undefined;
    if (code) carriers.set(code, (carriers.get(code) ?? new Set()).add(c.n));
  }
  const before = new Map<string, (typeof live)[number][]>();
  for (const row of live) {
    const code = row.requirementCriterionId ? codeOf.get(row.requirementCriterionId) : undefined;
    if (code) before.set(code, [...(before.get(code) ?? []), row]);
  }
  const dropped: DroppedTrace[] = [];
  for (const [code, lines] of before) {
    const carried = carriers.get(code) ?? new Set<number>();
    if (lines.length <= carried.size) continue;
    const bare = lines.filter((row) => !keptRows.has(row) && !carried.has(row.n));
    if (bare.length === 0) dropped.push({ n: null, code });
    for (const row of bare) dropped.push({ n: row.n, code });
  }
  return dropped.sort(
    (a, b) => (a.n ?? Number.MAX_SAFE_INTEGER) - (b.n ?? Number.MAX_SAFE_INTEGER),
  );
}

const listed = (ns: readonly number[]) =>
  ns.length === 1
    ? `criterion ${ns[0]}`
    : `criteria ${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`;

/** The refusal detail for a write `matchCriteria` could not map. */
export function ambiguousDetail(moves: readonly AmbiguousMove[]): string {
  const lines = moves.map(
    (m) =>
      `${listed(m.desired)} would carry the wording of live ${listed(m.live)} ("${m.statement.slice(0, 80)}") at a new number`,
  );
  return `${lines.join('; ')}, and that wording is repeated on this issue, so which criterion keeps the verdicts it earned cannot be told. Keep each repeated criterion at its own number, or word them apart`;
}

/** The refusal detail for a write that drops traced lines (`droppedTraces`), naming each and the way to keep it. */
export function droppedTraceDetail(dropped: readonly DroppedTrace[]): string {
  const named = dropped.filter((d): d is DroppedTrace & { n: number } => d.n !== null);
  const fewer = dropped.filter((d) => d.n === null).map((d) => d.code);
  const tags = [...new Set(dropped.map((d) => `(${d.code})`))].join(' or ');
  const what = [
    named.length > 0
      ? `drops the trace of ${listed(named.map((d) => d.n))}: ${named.map((d) => `criterion ${d.n} (${d.code})`).join(', ')}`
      : '',
    fewer.length > 0
      ? `leaves ${fewer.join(', ')} on fewer lines than it had, and every line that held it still carries it at its number, so which one lost it cannot be told`
      : '',
  ].filter(Boolean);
  return `this write ${what.join('; it ')}. A reworded or removed line is a new criterion here, and only an unchanged wording keeps its row and its trace, so the proof it held would vanish silently. Keep each trace with PUT /api/issues/:id/criteria, sending \`requirementCriterionId\` on that criterion, or open its line with ${tags}; to drop one on purpose, PUT the criteria with \`requirementCriterionId\` stated (null for none) on every one`;
}
