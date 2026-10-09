/**
 * The pattern rules (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`), pure over what the
 * service read: which catalog a project reads, what naming a pattern records, who may decide a new
 * one, and what the move to awaiting_release asks of an approved one. Each returns its refusals.
 */

import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import {
  type IssuePatternKind,
  PATTERN_CATALOG_DIR,
  PATTERN_ENTRY_MISSING,
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
  decision: PatternDecision | null;
  retractedAt: Date | null;
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

/** Whether `actorUserId` may decide this row: a new pattern, live, undecided, named by someone else. */
export function decideRefusals(
  issueRef: string,
  row: PatternRowFacts,
  actorUserId: string,
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
  if (row.namedBy === actorUserId) {
    return [
      refusal(
        'PATTERN_REVIEWER_IS_AUTHOR',
        `you named \`${row.pattern}\` on ${issueRef}, so another holder of patterns.approve decides it: a new pattern has one reviewer, never its author`,
      ),
    ];
  }
  return [];
}

export function retractRefusals(issueRef: string, row: PatternRowFacts): PatternRefusal[] {
  if (row.retractedAt === null) return [];
  return [refusal('PATTERN_RETRACTED', `\`${row.pattern}\` on ${issueRef} is already retracted`)];
}

/** A new pattern waiting on its reviewer, in the words every dispatch door refuses it with. */
export function pendingDetail(issueRef: string, patterns: readonly string[]): string {
  const named = patterns.map((p) => `\`${p}\``).join(', ');
  return `${PATTERN_REVIEW_PENDING}: ${issueRef} names the new pattern${patterns.length > 1 ? 's' : ''} ${named}, which wait${patterns.length > 1 ? '' : 's'} on one reviewer holding patterns.approve; the issue is held until each is approved or returned, or the issue retracts it and names a catalogued pattern`;
}

/**
 * What the move to awaiting_release asks of the issue's patterns: none waits on its reviewer, and
 * every approved new one has its entry in the catalog the project reads. A returned or retracted
 * row asks nothing.
 */
export function releaseFaults(
  issueRef: string,
  rows: readonly PatternRowFacts[],
  catalog: CatalogReading,
): { code: typeof PATTERN_REVIEW_PENDING | typeof PATTERN_ENTRY_MISSING; detail: string }[] {
  const live = rows.filter((r) => r.kind === 'new' && r.retractedAt === null);
  const pending = live.filter((r) => r.decision === null).map((r) => r.pattern);
  const faults: {
    code: typeof PATTERN_REVIEW_PENDING | typeof PATTERN_ENTRY_MISSING;
    detail: string;
  }[] = [];
  if (pending.length > 0) {
    faults.push({ code: PATTERN_REVIEW_PENDING, detail: pendingDetail(issueRef, pending) });
  }
  const approved = live.filter((r) => r.decision === 'approved').map((r) => r.pattern);
  const missing =
    catalog.kind === 'read' ? approved.filter((p) => !catalog.slugs.has(p)) : approved;
  if (missing.length > 0) {
    faults.push({
      code: PATTERN_ENTRY_MISSING,
      detail: `${issueRef} introduced the approved new pattern${missing.length > 1 ? 's' : ''} ${missing.map((p) => `\`${p}\``).join(', ')}, and the catalog its project reads holds no entry for ${missing.length > 1 ? 'them' : 'it'}: the entry (${missing.map((p) => `${PATTERN_CATALOG_DIR}/${p}.md`).join(', ')}) lands in this issue's own change, and is read once the build that carries it is the one running`,
    });
  }
  return faults;
}
