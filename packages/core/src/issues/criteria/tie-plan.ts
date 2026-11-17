// What one `POST /api/issues/:id/criteria/traces` will write, read before anything is (ISS-1283):
// each tie of an existing line to a code, and each code added as a line of its own. epod ISS-187
// (FB-711, FB-230 before it) sent the codes of its three proven lines and got three unjudged copies
// beside them, kept forever on a closed issue; a tie keeps the line, and an add a line already words
// is refused naming it.

import { normalizeStatement, withoutLeadTag } from './criteria-text.js';
import { refuseCriteria } from './store.js';
import { liveWordingAt, type Wording } from './trace-wording.js';

export interface PlanRow {
  readonly id: string;
  readonly n: number;
  readonly statement: string;
  readonly position: number;
  readonly requirementCriterionId: string | null;
}

export interface PlanRequirement {
  readonly seq: number;
  readonly current: number | null;
}

/** A live line tied in place: its id, and so its verdicts, kept; its words opened with the tag. */
export interface PlannedTie {
  readonly row: PlanRow;
  readonly code: string;
  readonly statement: string;
  readonly requirementCriterionId: string;
}

/** A code added as a line, or a line on an earlier wording of it re-added under its own number. */
export interface PlannedAdd {
  readonly n: number;
  readonly statement: string;
  readonly requirementCriterionId: string;
  readonly position: number;
  readonly refreshes: string | null;
}

/** Said in every refusal that sends an add to the tie: what "already words" was read as. */
export const WORDED_RULE =
  'the same words as the BC once its lead tag, letter case, runs of spaces and a closing full stop are set aside';

/** A statement's words as a BC's are compared with them (`WORDED_RULE`): exact after that, never fuzzy. */
export function wordsOf(statement: string): string {
  return normalizeStatement(withoutLeadTag(statement)).toLowerCase().replace(/\.$/u, '').trimEnd();
}

const tieForm = (n: number, code: string) => `\`{ ties: [{ n: ${n}, code: '${code}' }] }\``;

function wordingOf(
  wordings: readonly Wording[],
  req: PlanRequirement,
  code: string,
  path: string,
): Wording {
  const wording = liveWordingAt(wordings, code, req.current);
  if (wording) return wording;
  throw refuseCriteria(
    'CRITERIA_TRACE_UNRESOLVED',
    `REQ-${req.seq} has no wording of ${code} live at revision ${req.current ?? 'none'}, its current one`,
    path,
  );
}

function codeOf(wordings: readonly Wording[], row: PlanRow): string | null {
  return wordings.find((w) => w.id === row.requirementCriterionId)?.code ?? null;
}

/**
 * Each tie, refused by name where its line is not live, already traces a BC (a line's trace changes
 * only through the whole-list PUT, which retires it with its verdicts), or where another live line
 * of the issue traces the code.
 */
export function planTies(
  rows: readonly PlanRow[],
  wordings: readonly Wording[],
  req: PlanRequirement,
  ties: ReadonlyArray<{ n: number; code: string }>,
): PlannedTie[] {
  return ties.map(({ n, code }, at) => {
    const path = `/ties/${at}`;
    const row = rows.find((r) => r.n === n);
    if (!row) {
      const held = rows.map((r) => r.n).sort((a, b) => a - b);
      throw refuseCriteria(
        'CRITERION_UNKNOWN',
        `this issue has no live criterion ${n}; its live criteria are ${held.join(', ') || 'none'}`,
        path,
      );
    }
    const wording = wordingOf(wordings, req, code, path);
    const holder = rows.find((r) => codeOf(wordings, r) === code);
    if (holder) {
      const earlier =
        holder.requirementCriterionId === wording.id
          ? ''
          : `, at an earlier wording: send \`{ codes: ['${code}'] }\` to bring it to the current one`;
      throw refuseCriteria(
        'CRITERIA_TRACE_DUPLICATE',
        `REQ-${req.seq} ${code} is already traced by criterion ${holder.n} of this issue${earlier}`,
        path,
      );
    }
    const held = codeOf(wordings, row);
    if (row.requirementCriterionId !== null) {
      throw refuseCriteria(
        'CRITERIA_TIE_TRACED',
        `criterion ${n} already traces ${held ? `REQ-${req.seq} ${held}` : 'a business criterion'}, and its verdicts prove that one: a tie takes a line that traces none. To move its trace, PUT /api/issues/:id/criteria, which retires it and its verdicts`,
        path,
      );
    }
    return {
      row,
      code,
      statement: `(REQ-${req.seq} ${code}) ${withoutLeadTag(row.statement)}`,
      requirementCriterionId: wording.id,
    };
  });
}

/**
 * Each code added as a line worded as its BC, after the issue's last number; a line tracing an
 * earlier wording of it is re-added under its own number. Refused by name where a live line already
 * traces it at its current wording, or already words it (`WORDED_RULE`), naming that line and the tie.
 */
export function planAdds(
  rows: readonly PlanRow[],
  wordings: readonly Wording[],
  req: PlanRequirement,
  codes: readonly string[],
): PlannedAdd[] {
  let next = Math.max(0, ...rows.map((r) => r.n)) + 1;
  let position = rows.length;
  return codes.map((code) => {
    const wording = wordingOf(wordings, req, code, '/codes');
    const held = rows.find((r) => codeOf(wordings, r) === code);
    if (held?.requirementCriterionId === wording.id) {
      throw refuseCriteria(
        'CRITERIA_TRACE_DUPLICATE',
        `REQ-${req.seq} ${code} is already traced by criterion ${held.n} of this issue, at its current wording`,
        '/codes',
      );
    }
    const words = wordsOf(wording.body);
    const twin = held ? undefined : rows.find((r) => wordsOf(r.statement) === words);
    if (twin) {
      throw refuseCriteria(
        'CRITERIA_TRACE_WORDED',
        `criterion ${twin.n} already words REQ-${req.seq} ${code} (${WORDED_RULE}): adding it would put an unjudged copy beside it. Tie that line instead, ${tieForm(twin.n, code)}, which keeps its id and verdicts; nothing was written`,
        '/codes',
      );
    }
    const statement = `(REQ-${req.seq} ${code}) ${wording.body.trim()}`;
    return held
      ? {
          n: held.n,
          statement,
          requirementCriterionId: wording.id,
          position: held.position,
          refreshes: held.id,
        }
      : {
          n: next++,
          statement,
          requirementCriterionId: wording.id,
          position: position++,
          refreshes: null,
        };
  });
}
