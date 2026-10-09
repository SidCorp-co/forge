/**
 * The pattern rules (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`), pure over what the
 * service read: which catalog a project reads, what naming a pattern records, who may decide a new
 * one, what a return holds until it is answered, and what the move to awaiting_release asks. The
 * catalog entry is asked by the merge check, which reads the change (`pattern-entry.ts`). Each
 * returns its refusals.
 */

import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import {
  type IssuePatternKind,
  PATTERN_CATALOG_DIR,
  PATTERN_RETURNED,
  PATTERN_REVIEW_PENDING,
  type PatternDecision,
  type PatternRefusal,
} from '@forge/contracts/patterns';
import { THIS_REPOSITORY } from '../lib/this-repository.js';

/** The catalog a project reads: this build's, where the project declares this repository. */
export type CatalogReading =
  | { kind: 'read'; slugs: ReadonlySet<string> }
  | { kind: 'undeclared'; detail: string };

export function catalogReadingOf(repository: string | null | undefined): CatalogReading {
  if (repository === THIS_REPOSITORY) {
    return { kind: 'read', slugs: new Set(PATTERN_CATALOG.map((e) => e.slug)) };
  }
  return {
    kind: 'undeclared',
    detail: `this project's declared repository is ${repository ? `\`${repository}\`` : 'none'}, and Forge reads a pattern catalog only from the build of ${THIS_REPOSITORY}, whose pages are \`${PATTERN_CATALOG_DIR}/<slug>.md\`. Name a pattern on an issue of a project built from that repository`,
  };
}

/** A row as the rules read it. */
export interface PatternRowFacts {
  id: string;
  pattern: string;
  kind: IssuePatternKind;
  namedBy: string;
  /** The run session that named it; null where a person did. */
  namedSession: string | null;
  createdAt: Date;
  decision: PatternDecision | null;
  decidedAt: Date | null;
  retractedAt: Date | null;
}

/**
 * Who asks to decide a row. `box` is set on a box's credential, whose runs share one account, and
 * `session` is the run it was told to be (the issue's lease on that box, or the call's `run`).
 * `namerLiveHere` says whether the run that named the row is still a live session on that box.
 */
export interface PatternDecider {
  userId: string;
  box: string | null;
  session: string | null;
  namerLiveHere: boolean;
}

const refusal = (code: PatternRefusal['code'], detail: string, path = ''): PatternRefusal => ({
  code,
  path,
  detail,
});

/** What naming `pattern` records, or why it is refused. `live` is the issue's rows of that slug. */
export function nameOutcome(args: {
  issueRef: string;
  terminal: boolean;
  catalog: CatalogReading;
  pattern: string;
  summary: string | null;
  live: readonly PatternRowFacts[];
}): { ok: true; kind: IssuePatternKind } | { ok: false; refusals: PatternRefusal[] } {
  const { issueRef, catalog, pattern } = args;
  if (args.terminal) {
    return {
      ok: false,
      refusals: [
        refusal(
          'PATTERN_ISSUE_FINISHED',
          `${issueRef} is closed or dropped, so it builds nothing and names no pattern`,
        ),
      ],
    };
  }
  if (catalog.kind === 'undeclared') {
    return { ok: false, refusals: [refusal('PATTERN_CATALOG_UNDECLARED', catalog.detail)] };
  }
  const held = args.live.find(
    (r) => r.pattern === pattern && r.retractedAt === null && r.decision !== 'returned',
  );
  if (held) {
    return {
      ok: false,
      refusals: [
        refusal(
          'PATTERN_ALREADY_NAMED',
          `${issueRef} already names \`${pattern}\` (${held.id}); retract it first to name it again`,
          '/pattern',
        ),
      ],
    };
  }
  if (catalog.slugs.has(pattern)) return { ok: true, kind: 'reuse' };
  if (args.summary === null) {
    return {
      ok: false,
      refusals: [
        refusal(
          'PATTERN_SUMMARY_REQUIRED',
          `\`${pattern}\` is no catalog entry (${PATTERN_CATALOG_DIR}/${pattern}.md), so it is a new pattern and its reviewer reads what it is: send \`summary\` saying what the pattern is and why no catalogued one serves, or name a catalogued slug`,
          '/summary',
        ),
      ],
    };
  }
  return { ok: true, kind: 'new' };
}

/**
 * Whether `decider` may decide this row: a new pattern, live, undecided, and not its author. A run's
 * pattern is refused only to that run, whatever account it shares; a person's is refused to that
 * person's account. A box call that cannot say which run it is, on the box where the naming run is
 * still live, is refused rather than guessed.
 */
export function decideRefusals(
  issueRef: string,
  row: PatternRowFacts,
  decider: PatternDecider,
): PatternRefusal[] {
  if (row.kind !== 'new') {
    return [
      refusal(
        'PATTERN_NOT_NEW',
        `\`${row.pattern}\` is a catalog entry ${issueRef} reuses; reuse needs no approval, so there is nothing to decide`,
      ),
    ];
  }
  if (row.retractedAt !== null) {
    return [
      refusal(
        'PATTERN_RETRACTED',
        `${issueRef} retracted \`${row.pattern}\`, so it no longer waits on a decision`,
      ),
    ];
  }
  if (row.decision !== null) {
    return [
      refusal(
        'PATTERN_ALREADY_DECIDED',
        `\`${row.pattern}\` on ${issueRef} was already ${row.decision}; a decision is taken once`,
      ),
    ];
  }
  return authorRefusals(issueRef, row, decider);
}

function authorRefusals(
  issueRef: string,
  row: PatternRowFacts,
  decider: PatternDecider,
): PatternRefusal[] {
  if (row.namedSession === null) {
    if (row.namedBy !== decider.userId) return [];
    return [
      refusal(
        'PATTERN_REVIEWER_IS_AUTHOR',
        `you named \`${row.pattern}\` on ${issueRef}, so another holder of patterns.approve decides it: a new pattern has one reviewer, never its author`,
      ),
    ];
  }
  if (decider.session === row.namedSession) {
    return [
      refusal(
        'PATTERN_REVIEWER_IS_AUTHOR',
        `this run (session ${row.namedSession}) named \`${row.pattern}\` on ${issueRef}, so another run or a person holding patterns.approve decides it: a new pattern has one reviewer, never the run that wrote it`,
      ),
    ];
  }
  if (decider.box !== null && decider.session === null && decider.namerLiveHere) {
    return [
      refusal(
        'PATTERN_REVIEWER_RUN_UNNAMED',
        `\`${row.pattern}\` on ${issueRef} was named by a run that is still live on this box (session ${row.namedSession}), and this box's runs share one credential, so this call could be that run. Send \`run\`, the run id this box declared for the run deciding, or decide it as a person`,
        '/run',
      ),
    ];
  }
  return [];
}

/**
 * The returned rows no later live row answers: the issue has named neither another pattern nor the
 * slug again since the return. A retracted later row answers nothing.
 */
export function unansweredReturns(rows: readonly PatternRowFacts[]): PatternRowFacts[] {
  const live = rows.filter((r) => r.retractedAt === null);
  return live.filter(
    (r) =>
      r.decision === 'returned' &&
      r.decidedAt !== null &&
      !live.some((later) => later.id !== r.id && later.createdAt > (r.decidedAt as Date)),
  );
}

/** An unanswered return, in the words the build step and the move to awaiting_release refuse it with. */
export function returnedDetail(issueRef: string, patterns: readonly string[]): string {
  const named = patterns.map((p) => `\`${p}\``).join(', ');
  return `${PATTERN_RETURNED}: the reviewer returned ${named} on ${issueRef}, and the issue has not answered: name a catalogued pattern instead, or name ${patterns.length > 1 ? 'each slug' : 'the slug'} again with a revised summary for a new review. Until then its work does not move to build and it does not move to awaiting_release`;
}

export function retractRefusals(issueRef: string, row: PatternRowFacts): PatternRefusal[] {
  if (row.retractedAt !== null) {
    return [refusal('PATTERN_RETRACTED', `\`${row.pattern}\` on ${issueRef} is already retracted`)];
  }
  if (row.decision === 'returned') {
    return [
      refusal(
        PATTERN_RETURNED,
        `\`${row.pattern}\` on ${issueRef} was returned, and it stays as the record of that return. A return is answered by naming another pattern or naming the slug again revised, not by retracting it`,
      ),
    ];
  }
  return [];
}

/** A new pattern waiting on its reviewer, in the words every dispatch door refuses it with. */
export function pendingDetail(issueRef: string, patterns: readonly string[]): string {
  const named = patterns.map((p) => `\`${p}\``).join(', ');
  return `${PATTERN_REVIEW_PENDING}: ${issueRef} names the new pattern${patterns.length > 1 ? 's' : ''} ${named}, which wait${patterns.length > 1 ? '' : 's'} on one reviewer holding patterns.approve; the issue is held until each is approved or returned, or the issue retracts it and names a catalogued pattern`;
}

/**
 * What the move to awaiting_release asks of the issue's patterns: none waits on its reviewer, and no
 * return stands unanswered. The catalog entry is not asked here: it is in the change, which the merge
 * check reads (`pattern-entry.ts`), and the running build holds it only after a release.
 */
export function releaseFaults(
  issueRef: string,
  rows: readonly PatternRowFacts[],
): { code: typeof PATTERN_REVIEW_PENDING | typeof PATTERN_RETURNED; detail: string }[] {
  const pending = rows
    .filter((r) => r.kind === 'new' && r.retractedAt === null && r.decision === null)
    .map((r) => r.pattern);
  const faults: {
    code: typeof PATTERN_REVIEW_PENDING | typeof PATTERN_RETURNED;
    detail: string;
  }[] = [];
  if (pending.length > 0) {
    faults.push({ code: PATTERN_REVIEW_PENDING, detail: pendingDetail(issueRef, pending) });
  }
  const returned = unansweredReturns(rows).map((r) => r.pattern);
  if (returned.length > 0) {
    faults.push({ code: PATTERN_RETURNED, detail: returnedDetail(issueRef, returned) });
  }
  return faults;
}
