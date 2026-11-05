// ISS-673 — the traced lines a whole criteria write rewords or removes without restating their trace,
// named as the writer sent them: by their number in the new text and their new words.

import { normalizeStatement, withoutLeadTag } from './criteria-text.js';
import { matchCriteria } from './match.js';

interface TracedRow {
  readonly n: number;
  readonly statement: string;
  readonly requirementCriterionId: string | null;
}

interface SentLine {
  readonly n: number;
  readonly statement: string;
  readonly requirementCriterionId?: string | null | undefined;
}

/** A criterion by its number and words: a live one as it stands, or one as the write sent it. */
export interface CriterionLine {
  readonly n: number;
  readonly statement: string;
}

/**
 * A trace a write would drop, by the requirement criterion's code (`REQ-n BC-m`):
 * - `line`: the sent line that carries on `was` (a live line it rewords, or several where it is the
 *   one free line left in their place) and does not carry the BC; tagging `line` keeps it;
 * - `removed`: `was` has no line in its place in the write;
 * - `unclear`: `was` held the BC on `short` more lines than the write carries it on in their place,
 *   and which of `candidates` carries it on cannot be told from their words, so none is guessed.
 */
export type DroppedTrace =
  | {
      readonly kind: 'line';
      readonly code: string;
      readonly line: CriterionLine;
      readonly was: readonly CriterionLine[];
      readonly reworded: boolean;
      /** The other BC the line carries in its place, where it carries one. */
      readonly instead?: string;
    }
  | { readonly kind: 'removed'; readonly code: string; readonly was: CriterionLine }
  | {
      readonly kind: 'unclear';
      readonly code: string;
      readonly was: readonly CriterionLine[];
      readonly candidates: readonly CriterionLine[];
      readonly short: number;
    };

/** Words two lines share at or above which a reworded line is the live one it shares them with. */
const LIKE = 0.5;
const WORD = /[\p{L}\p{N}]+/gu;

function wordsOf(statement: string): ReadonlySet<string> {
  return new Set(withoutLeadTag(statement).toLowerCase().match(WORD) ?? []);
}

/** The share of words two lines hold in common (Dice), 0 to 1. */
function likeness(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size + b.size === 0) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common += 1;
  return (2 * common) / (a.size + b.size);
}

/** The one free index scoring highest at or above LIKE, or undefined where none does or two tie. */
function soleBest(score: (k: number) => number, free: ReadonlySet<number>): number | undefined {
  let best: number | undefined;
  let top = -1;
  let tied = false;
  for (const k of free) {
    const s = score(k);
    if (s > top) [best, top, tied] = [k, s, false];
    else if (s === top) tied = true;
  }
  return top >= LIKE && !tied ? best : undefined;
}

/**
 * Reworded live rows paired with the sent lines that carry them on by their words: a row and a line
 * that are each other's one best likeness at LIKE or more, taken round by round until none is left,
 * so a line taken by its true row is no rival for the next one.
 */
function pairByWords(
  rows: ReadonlySet<number>,
  lines: ReadonlySet<number>,
  liveWords: readonly ReadonlySet<string>[],
  sentWords: readonly ReadonlySet<string>[],
): Map<number, number> {
  const pairs = new Map<number, number>();
  const freeRows = new Set(rows);
  const freeLines = new Set(lines);
  const like = (j: number, i: number) =>
    likeness(liveWords[j] as ReadonlySet<string>, sentWords[i] as ReadonlySet<string>);
  for (let found = true; found; ) {
    found = false;
    const round: [number, number][] = [];
    for (const j of freeRows) {
      const i = soleBest((k) => like(j, k), freeLines);
      if (i !== undefined && soleBest((k) => like(k, i), freeRows) === j) round.push([j, i]);
    }
    for (const [j, i] of round) {
      pairs.set(j, i);
      freeRows.delete(j);
      freeLines.delete(i);
      found = true;
    }
  }
  return pairs;
}

interface Place {
  readonly rows: number[];
  readonly lines: number[];
}

/**
 * The rows and lines left unpaired, grouped by the place they stand in between the anchors (rows
 * kept or paired by words): a row left between two anchors can only have become a line left between
 * the same two. Where the anchors cross (a kept line moved past another), places cannot be told
 * apart, and every leftover stands in one.
 */
function placesOf(
  anchors: readonly (readonly [number, number])[],
  rows: readonly number[],
  lines: readonly number[],
  rank: ReadonlyMap<number, number>,
): Place[] {
  const ordered = [...anchors].sort(([a], [b]) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  const crossing = ordered.some(([, i], k) => k > 0 && i < (ordered[k - 1] as [number, number])[1]);
  if (crossing) return [{ rows: [...rows], lines: [...lines] }];
  const places: Place[] = ordered.map(() => ({ rows: [], lines: [] }));
  places.push({ rows: [], lines: [] });
  for (const j of rows) {
    const at = ordered.filter(([a]) => (rank.get(a) ?? 0) < (rank.get(j) ?? 0)).length;
    places[at]?.rows.push(j);
  }
  for (const i of lines) places[ordered.filter(([, a]) => a < i).length]?.lines.push(i);
  return places;
}

const lineOf = (c: CriterionLine): CriterionLine => ({ n: c.n, statement: c.statement });

/**
 * The traced lines a write rewords or removes without restating their trace (HOP ISS-39, whose
 * 2026-10-06 rewrite left REQ-25 BC-1, BC-2 and BC-7 with no issue; catalog-api ISS-3, whose reworded
 * line lost BC-3 while another line still traced it). A reworded line is a new criterion
 * (`matchCriteria` keeps a row only for an unchanged wording), so each live row it did not keep is
 * paired with the sent line that carries it on — by its words first (`pairByWords`), then by its place
 * between the lines kept or paired (`placesOf`) — and never by its number, which an inserted line
 * takes over (ISS-673, K76). A pair whose line does not carry the row's BC is named by the line as
 * sent; a place left with no line names the row as removed; and a place whose free lines cannot be
 * told apart names every one of them, guessing none. `codeOf` takes a wording id to its `REQ-n BC-m`,
 * absent for one that is no proof to lose. Where every sent criterion states its trace
 * (`requirementCriterionId` given, `null` meaning none) the writer said so and nothing is refused.
 */
export function droppedTraces(
  live: readonly TracedRow[],
  sent: readonly SentLine[],
  codeOf: ReadonlyMap<string, string>,
): DroppedTrace[] {
  if (sent.every((c) => c.requirementCriterionId !== undefined)) return [];
  const { kept } = matchCriteria(live, sent);
  const codeAt = (id: string | null | undefined) => (id ? codeOf.get(id) : undefined);
  const carries = (i: number) => {
    const c = sent[i] as SentLine;
    return codeAt(
      c.requirementCriterionId === undefined
        ? kept.get(i)?.requirementCriterionId
        : c.requirementCriterionId,
    );
  };
  const keptAt = new Map([...kept].map(([i, row]) => [live.indexOf(row), i] as const));
  const rows = new Set(live.flatMap((_, j) => (keptAt.has(j) ? [] : [j])));
  const lines = new Set(sent.flatMap((_, i) => (kept.has(i) ? [] : [i])));
  const byWords = pairByWords(
    rows,
    lines,
    live.map((r) => wordsOf(r.statement)),
    sent.map((c) => wordsOf(c.statement)),
  );

  const dropped: DroppedTrace[] = [];
  const paired = (pairs: Map<number, number>, reworded: boolean) => {
    for (const [j, i] of pairs) {
      const code = codeAt((live[j] as TracedRow).requirementCriterionId);
      const now = carries(i);
      if (!code || now === code) continue;
      const was = [lineOf(live[j] as TracedRow)];
      const line = lineOf(sent[i] as SentLine);
      dropped.push({ kind: 'line', code, line, was, reworded, ...(now ? { instead: now } : {}) });
    }
  };
  paired(keptAt, false);
  paired(byWords, true);

  const rank = new Map(
    live
      .map((r, j) => [r.n, j] as const)
      .sort(([a], [b]) => a - b)
      .map(([, j], k) => [j, k] as const),
  );
  const pairedLines = new Set(byWords.values());
  const places = placesOf(
    [...keptAt, ...byWords],
    [...rows]
      .filter((j) => !byWords.has(j))
      .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    [...lines].filter((i) => !pairedLines.has(i)).sort((a, b) => a - b),
    rank,
  );
  for (const place of places) dropped.push(...droppedAt(place, live, sent, codeAt, carries));
  const at = (d: DroppedTrace) =>
    d.kind === 'line' ? d.line.n : d.kind === 'removed' ? 1e9 + d.was.n : 2e9 + (d.was[0]?.n ?? 0);
  return dropped.sort((a, b) => at(a) - at(b) || a.code.localeCompare(b.code));
}

/**
 * The traces one place loses: each BC its rows held on more lines than its lines carry it on. A place
 * with no line lost its rows outright. Its untraced lines are the ones free to carry a BC on, and
 * they are named as certain only where exactly one BC is short and exactly as many are free, so
 * tagging each named line is a write that is taken; otherwise every free line is named as unclear.
 */
function droppedAt(
  place: Place,
  live: readonly TracedRow[],
  sent: readonly SentLine[],
  codeAt: (id: string | null | undefined) => string | undefined,
  carries: (i: number) => string | undefined,
): DroppedTrace[] {
  const held = new Map<string, CriterionLine[]>();
  for (const j of place.rows) {
    const row = live[j] as TracedRow;
    const code = codeAt(row.requirementCriterionId);
    if (code) held.set(code, [...(held.get(code) ?? []), lineOf(row)]);
  }
  if (place.lines.length === 0)
    return [...held].flatMap(([code, was]) =>
      was.map((w) => ({ kind: 'removed', code, was: w }) as const),
    );
  const short = [...held].flatMap(([code, was]) => {
    const n = was.length - place.lines.filter((i) => carries(i) === code).length;
    return n > 0 ? [{ code, was, n }] : [];
  });
  const free = place.lines
    .filter((i) => carries(i) === undefined)
    .map((i) => lineOf(sent[i] as SentLine));
  const only = short.length === 1 ? short[0] : undefined;
  if (only && free.length === only.n)
    return free.map(
      (line) => ({ kind: 'line', code: only.code, line, was: only.was, reworded: true }) as const,
    );
  return short.map(
    ({ code, was, n }) => ({ kind: 'unclear', code, was, candidates: free, short: n }) as const,
  );
}

const quoted = (statement: string) => {
  const s = normalizeStatement(statement);
  return `"${s.length > 80 ? `${s.slice(0, 79)}…` : s}"`;
};
const each = (ls: readonly CriterionLine[], word: string, joiner = 'and') =>
  ls.length === 1
    ? `${word} ${ls[0]?.n} (${quoted(ls[0]?.statement ?? '')})`
    : `${word.replace(/ion$/u, 'ia')} ${ls
        .map((l) => `${l.n} (${quoted(l.statement)})`)
        .join(', ')
        .replace(/, ([^,]*)$/u, ` ${joiner} $1`)}`;
const numbers = (ls: readonly CriterionLine[], joiner: string) =>
  ls.length === 1
    ? `criterion ${ls[0]?.n}`
    : `criteria ${ls
        .map((l) => l.n)
        .join(', ')
        .replace(/, ([^,]*)$/u, ` ${joiner} $1`)}`;

function said(d: DroppedTrace): { what: string; fix: string } {
  const tag = `(${d.code})`;
  if (d.kind === 'removed') {
    return {
      what: `${each([d.was], 'live criterion')}, which proved ${d.code}, has no line in its place`,
      fix: `put live criterion ${d.was.n} back, opening with ${tag}`,
    };
  }
  if (d.kind === 'line') {
    const verb = d.reworded ? 'rewords' : 'is';
    const was =
      d.was.length === 1
        ? each(d.was, 'live criterion')
        : `one of ${each(d.was, 'live criterion')}`;
    return {
      what: `${each([d.line], 'criterion')} as sent ${verb} ${was}, which proved ${d.code}, and ${d.instead ? `carries ${d.instead} instead` : 'does not carry it'}`,
      fix: `open criterion ${d.line.n} with ${tag}${d.instead ? ` in place of (${d.instead})` : ''}`,
    };
  }
  const where =
    d.candidates.length === 0
      ? 'and no untraced line is left in their place to carry it on'
      : `and which of ${d.candidates.length > 5 ? numbers(d.candidates, 'or') : each(d.candidates, 'criterion', 'or')} as sent carries it on cannot be told from their words`;
  const pick =
    d.candidates.length === 0
      ? `put a line back opening with ${tag}`
      : `${d.short === 1 ? `open whichever of ${numbers(d.candidates, 'and')} carries it on` : `open the ${d.short} of ${numbers(d.candidates, 'and')} that carry it on`} with ${tag}${d.short > d.candidates.length ? `, and put the rest back opening with ${tag}` : ''}`;
  return {
    what: `${each(d.was, 'live criterion')} held ${d.code} on ${d.short} more ${d.short === 1 ? 'line' : 'lines'} than this write carries it on in their place, ${where}`,
    fix: pick,
  };
}

/** The refusal detail for a write that drops traced lines (`droppedTraces`), naming each as sent and the way to keep it. */
export function droppedTraceDetail(dropped: readonly DroppedTrace[]): string {
  const parts = dropped.map(said);
  return `this write drops a requirement trace: ${parts.map((p) => p.what).join('; ')}. A reworded line is paired with the live line it carries on by its words, or by its place between the lines left unchanged, never by its number; only an unchanged wording keeps its row and its trace, so the proof it held would vanish silently. To keep each trace, ${parts.map((p) => p.fix).join('; ')}, or send \`requirementCriterionId\` on that criterion with PUT /api/issues/:id/criteria; to drop one on purpose, PUT the criteria with \`requirementCriterionId\` stated (null for none) on every one. Each BC's id reads at GET /api/issues/:id/requirement (\`revision.criteria\`), whichever project holds the requirement, and each line's current one at GET /api/issues/:id/criteria`;
}
