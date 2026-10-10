/**
 * The review's rules (REQ-36 BC-8; Issue to release r20 `rule-merge`), pure over what `review.ts`
 * read: the lines a review of an issue owes, why a review is refused, whether its reviewer is the
 * building run, the fields it is recorded as, and the mark's refusal where none passing stands.
 *
 * The lines owed are each checklist line of every pattern the issue's design chose, as this build's
 * catalog holds it, and each criterion the design classes a code property. A project that reads no
 * catalog chooses no pattern, so its review owes only the code-property criteria, and the record
 * says so. A chosen pattern this build's catalog holds no page for (an approved new one, whose page
 * lands in the same change) owes no line until a release carries its page; the record names it.
 */

import { CHECK_RUN_LIMITS, type IssueCheckRunView } from '@forge/contracts/check-runs';
import type { CriterionDesignView, IssueDesignView } from '@forge/contracts/issue-design';
import type {
  IssueReviewRefusalCode,
  OwedChecklistLine,
  RecordReviewRequest,
  ReviewOutcome,
  ReviewOwed,
} from '@forge/contracts/issue-review';
import type { PatternEntry } from '@forge/contracts/patterns';
import type { CatalogReading } from './pattern-rules.js';

export interface ReviewRefusal {
  code: IssueReviewRefusalCode;
  path: string;
  detail: string;
}

const refusal = (code: IssueReviewRefusalCode, detail: string, path = ''): ReviewRefusal => ({
  code,
  path,
  detail,
});

const lineKey = (pattern: string, line: number) => `${pattern}#${line}`;

/** What a review of this design owes, against the catalog this build carries. */
export function owedOf(args: {
  design: Pick<IssueDesignView, 'criteria'>;
  catalog: CatalogReading;
  entries: readonly Pick<PatternEntry, 'slug' | 'checklist'>[];
}): ReviewOwed {
  const { design, catalog } = args;
  const chosen = [
    ...new Set(design.criteria.flatMap((c) => (c.pattern === null ? [] : [c.pattern]))),
  ].sort();
  const bySlug = new Map(args.entries.map((e) => [e.slug, e]));
  const checklist: OwedChecklistLine[] = [];
  const unread: string[] = [];
  for (const slug of chosen) {
    const entry = bySlug.get(slug);
    if (!entry) {
      unread.push(slug);
      continue;
    }
    for (const [at, text] of entry.checklist.entries()) {
      checklist.push({ pattern: slug, line: at + 1, text });
    }
  }
  return {
    checklist,
    criteria: design.criteria
      .filter((c: CriterionDesignView) => c.class === 'code_property')
      .map((c) => ({ criterion: c.criterion, statement: c.statement }))
      .sort((a, b) => a.criterion - b.criterion),
    unread,
    noCatalog: catalog.kind === 'read' ? null : catalog.detail,
  };
}

function listed(keys: readonly string[], max = 12): string {
  const shown = keys.slice(0, max).map((k) => `\`${k}\``);
  return keys.length > max ? `${shown.join(', ')}, +${keys.length - max} more` : shown.join(', ');
}

/** The checklist results' refusals: a line twice, a line not owed, a fail or skip with no note. */
function checklistRefusals(body: RecordReviewRequest, owed: ReviewOwed): ReviewRefusal[] {
  const out: ReviewRefusal[] = [];
  const owedKeys = new Set(owed.checklist.map((l) => lineKey(l.pattern, l.line)));
  const seen = new Set<string>();
  for (const [at, r] of body.checklist.entries()) {
    const key = lineKey(r.pattern, r.line);
    if (seen.has(key)) {
      out.push(
        refusal(
          'REVIEW_LINE_REPEATED',
          `checklist line ${key} is sent twice; a review gives each line one result`,
          `/checklist/${at}`,
        ),
      );
      continue;
    }
    seen.add(key);
    if (!owedKeys.has(key)) {
      const owes = owed.checklist.length
        ? `it owes ${listed([...owedKeys])}`
        : 'it owes no checklist line';
      out.push(
        refusal(
          'REVIEW_LINE_UNKNOWN',
          `checklist line ${key} is no line of a pattern this issue's design chose; ${owes}`,
          `/checklist/${at}`,
        ),
      );
    }
  }
  const missing = [...owedKeys].filter((k) => !seen.has(k));
  if (missing.length) {
    out.push(
      refusal(
        'REVIEW_LINE_MISSING',
        `the review gives no result for checklist line ${listed(missing)}; it gives one per line of each chosen pattern (GET /api/issues/:id/review lists them)`,
        '/checklist',
      ),
    );
  }
  return out;
}

function criterionRefusals(body: RecordReviewRequest, owed: ReviewOwed): ReviewRefusal[] {
  const out: ReviewRefusal[] = [];
  const owedNs = new Set(owed.criteria.map((c) => c.criterion));
  const seen = new Set<number>();
  for (const [at, r] of body.criteria.entries()) {
    if (seen.has(r.criterion)) {
      out.push(
        refusal(
          'REVIEW_LINE_REPEATED',
          `criterion ${r.criterion} is sent twice; a review gives each code-property criterion one result`,
          `/criteria/${at}`,
        ),
      );
      continue;
    }
    seen.add(r.criterion);
    if (!owedNs.has(r.criterion)) {
      const owes = owed.criteria.length
        ? `the code-property criteria are ${[...owedNs].join(', ')}`
        : 'the design classes no criterion a code property';
      out.push(
        refusal(
          'REVIEW_LINE_UNKNOWN',
          `criterion ${r.criterion} is not a code property in this issue's design, so the review does not judge it: ${owes}. An observable criterion is QA's, on the running build`,
          `/criteria/${at}`,
        ),
      );
    }
  }
  const missing = [...owedNs].filter((n) => !seen.has(n));
  if (missing.length) {
    out.push(
      refusal(
        'REVIEW_LINE_MISSING',
        `the review gives no result for code-property criterion ${missing.join(', ')}; it judges each one against the diff`,
        '/criteria',
      ),
    );
  }
  return out;
}

/** A clock a box may run ahead of core's by, before its start reads as one in the future. */
const CLOCK_SKEW_MS = 60_000;

/** Why the review's start cannot be timed against `now`, or null. */
function startedAtRefusal(startedAt: string, now: Date): ReviewRefusal | null {
  const took = now.getTime() - new Date(startedAt).getTime();
  if (took < -CLOCK_SKEW_MS) {
    return refusal(
      'REVIEW_REFUSED',
      `startedAt ${startedAt} is after now (${now.toISOString()}); it is when the review began`,
      '/startedAt',
    );
  }
  if (took > CHECK_RUN_LIMITS.durationMs) {
    return refusal(
      'REVIEW_REFUSED',
      `startedAt ${startedAt} is more than a day ago; a review that ran longer was left running, not timed`,
      '/startedAt',
    );
  }
  return null;
}

/** Why this review cannot be recorded against what it owes, or none. */
export function reviewRefusals(
  body: RecordReviewRequest,
  owed: ReviewOwed,
  now: Date = new Date(),
): ReviewRefusal[] {
  const out = [...checklistRefusals(body, owed), ...criterionRefusals(body, owed)];
  const started = startedAtRefusal(body.startedAt, now);
  if (started) out.push(started);
  if (body.base.toLowerCase() === body.head.toLowerCase()) {
    out.push(
      refusal(
        'REVIEW_REFUSED',
        'base and head are the same commit, so there is no diff to review; base is the commit the change was cut from',
        '/base',
      ),
    );
  }
  return out;
}

/** Who made the review call: the run session, the box, and the account. */
export interface Reviewer {
  session: string | null;
  box: string | null;
  actor: string;
}

/**
 * Who built the change, as core recorded it: the run sessions that hold the issue's lease or
 * recorded a check on it, and the accounts that recorded a check with no session. `liveOnBox` is
 * whether one of those sessions is still live on the reviewer's box.
 */
export interface Builders {
  sessions: ReadonlySet<string>;
  actors: ReadonlySet<string>;
  liveOnBox: boolean;
}

/**
 * Why this reviewer may not review the change, or null. The review is never the building run's (Issue
 * to release r20 `rule-merge`). A box's runs share one credential, so a box call that names no run
 * while a building run is live there could be that run, and is refused rather than guessed.
 */
export function reviewerRefusal(
  issueRef: string,
  reviewer: Reviewer,
  builders: Builders,
): ReviewRefusal | null {
  const who =
    'Send `run` naming the reviewing run (the run id this box declared), or review as a person who recorded none of its checks';
  if (reviewer.session !== null && builders.sessions.has(reviewer.session)) {
    return refusal(
      'REVIEW_BY_BUILDER',
      `this run (session ${reviewer.session}) built ${issueRef}: it holds the issue or recorded its checks, and a review is never the building run's. ${who}`,
    );
  }
  if (reviewer.session === null && reviewer.box === null && builders.actors.has(reviewer.actor)) {
    return refusal(
      'REVIEW_BY_BUILDER',
      `you recorded ${issueRef}'s checks, so you built it, and a review is never the builder's. A run other than the building run, or another person, reviews it`,
    );
  }
  if (
    reviewer.session === null &&
    reviewer.box !== null &&
    (builders.liveOnBox || builders.actors.has(reviewer.actor))
  ) {
    return refusal(
      'REVIEW_RUN_UNNAMED',
      `${issueRef} was built from this box, whose runs share one credential, so this call could be the building run. ${who}`,
      '/run',
    );
  }
  return null;
}

/** The review's outcome: pass only where every line and criterion holds. */
export function outcomeOf(body: RecordReviewRequest): { result: ReviewOutcome; failed: string[] } {
  const failed = [
    ...body.checklist.filter((r) => r.result === 'fail').map((r) => lineKey(r.pattern, r.line)),
    ...body.criteria.filter((r) => r.result === 'fail').map((r) => `criterion ${r.criterion}`),
  ];
  return { result: failed.length ? 'fail' : 'pass', failed };
}

const FIELD_MAX = 400;
const cut = (s: string) => (s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s);

/** What core read at the reviewed head, which the review cites instead of running anything. */
export interface HeadEvidence {
  checks: { kind: string; result: string }[];
  mergeCheckPassed: boolean;
  verdicts: number;
}

function evidenceLine(head: string, evidence: HeadEvidence): string {
  const kinds = [...new Set(evidence.checks.map((c) => c.kind))].sort();
  const red = evidence.checks.filter((c) => c.result === 'fail').length;
  const checks = evidence.checks.length
    ? `${evidence.checks.length} check(s) recorded at ${head.slice(0, 12)} (${kinds.join(', ')}${red ? `; ${red} red` : ''})`
    : `no check recorded at ${head.slice(0, 12)}`;
  const merge = evidence.mergeCheckPassed ? 'a passing merge check' : 'no passing merge check';
  return `${checks}; ${merge}; ${evidence.verdicts} verdict(s) judged at it`;
}

/** The fields a review is recorded as: the diff, the reviewer, each result, and the evidence cited. */
export function reviewRecordFields(args: {
  body: RecordReviewRequest;
  owed: ReviewOwed;
  reviewer: Reviewer;
  builders: Builders;
  evidence: HeadEvidence;
}): { key: string; value: string }[] {
  const { body, owed, reviewer, evidence } = args;
  const head = body.head.toLowerCase();
  const base = body.base.toLowerCase();
  const { result, failed } = outcomeOf(body);
  const patterns = [...new Set(owed.checklist.map((l) => l.pattern)), ...owed.unread];
  const fields = [
    {
      key: 'lead',
      value: `Review ${result} at ${head.slice(0, 12)}: ${body.checklist.length} checklist line(s), ${body.criteria.length} code-property criterion result(s)`,
    },
    { key: 'result', value: result },
    ...(failed.length ? [{ key: 'failed', value: cut(failed.join(', ')) }] : []),
    { key: 'base', value: base },
    { key: 'head', value: head },
    { key: 'diff', value: `${base}..${head}` },
    { key: 'started', value: new Date(body.startedAt).toISOString() },
    { key: 'patterns', value: patterns.length ? patterns.join(', ') : 'none' },
    { key: 'reviewer-session', value: reviewer.session ?? 'none' },
    { key: 'reviewer-box', value: reviewer.box ?? 'none' },
    { key: 'reviewer-actor', value: reviewer.actor },
    {
      key: 'builder',
      value: args.builders.sessions.size
        ? `run session ${[...args.builders.sessions].sort().join(', ')}`
        : args.builders.actors.size
          ? `account ${[...args.builders.actors].sort().join(', ')}`
          : 'none recorded: no run holds the issue and none recorded a check on it',
    },
  ];
  if (owed.noCatalog) {
    fields.push({ key: 'checklist', value: cut(`none owed: ${owed.noCatalog}`) });
  }
  for (const slug of owed.unread) {
    fields.push({
      key: 'checklist',
      value: `none owed for \`${slug}\`: this build's catalog holds no page for it yet`,
    });
  }
  for (const r of body.checklist) {
    fields.push({
      key: 'line',
      value: cut(`${lineKey(r.pattern, r.line)} ${r.result}: ${r.note}`),
    });
  }
  for (const r of body.criteria) {
    fields.push({
      key: 'criterion',
      value: cut(`${r.criterion} ${r.result}: ${r.reason} (${r.evidence.join('; ')})`),
    });
  }
  fields.push({ key: 'evidence', value: cut(evidenceLine(head, evidence)) });
  fields.push({
    key: 'reruns',
    value: `none: a review runs no check, test or probe; it cites those recorded at ${head.slice(0, 12)}`,
  });
  return fields;
}

/** A recorded review as the mark and the read take it back from its fields. */
export interface StoredReview {
  id: string;
  head: string;
  base: string;
  result: ReviewOutcome;
  failed: string[];
  reviewer: Reviewer;
  /** When the review began; null on one recorded before a review carried its start. */
  startedAt: Date | null;
  recordedAt: Date;
}

export function storedReviewOf(record: {
  id: string;
  fields: readonly { key: string; value: string }[];
  createdAt: Date;
}): StoredReview | null {
  const one = (key: string) => record.fields.find((f) => f.key === key)?.value;
  const head = one('head');
  const base = one('base');
  const result = one('result');
  const actor = one('reviewer-actor');
  if (!head || !base || !actor || (result !== 'pass' && result !== 'fail')) return null;
  const none = (v: string | undefined) => (v === undefined || v === 'none' ? null : v);
  const failed = one('failed')?.split(', ') ?? [];
  const started = one('started');
  return {
    id: record.id,
    head,
    base,
    result,
    failed,
    reviewer: { session: none(one('reviewer-session')), box: none(one('reviewer-box')), actor },
    startedAt: started ? new Date(started) : null,
    recordedAt: record.createdAt,
  };
}

/**
 * A recorded review as one check of kind `review` in the issue's check times (REQ-36 BC-14): timed
 * from its start to its record. A review recorded before it carried a start is listed untimed.
 */
export function reviewCheckViewOf(review: StoredReview): IssueCheckRunView {
  const started = review.startedAt ?? review.recordedAt;
  const failed = review.failed.length ? `Failed ${review.failed.join(', ')}` : null;
  const untimed = review.startedAt ? null : 'Untimed: recorded before a review carried its start';
  return {
    id: review.id,
    kind: 'review',
    name: 'Review',
    scope: `${review.base.slice(0, 7)}..${review.head.slice(0, 7)}`,
    command: 'POST /api/issues/:id/review',
    files: [],
    result: review.result,
    durationMs: Math.max(0, review.recordedAt.getTime() - started.getTime()),
    startedAt: started.toISOString(),
    head: review.head,
    note: [failed, untimed].filter(Boolean).join('. ') || null,
    runSessionId: review.reviewer.session,
    via: 'report',
    recordedAt: review.recordedAt.toISOString(),
  };
}

/**
 * The mark's MERGE_REVIEW_MISSING detail, or null where a passing review by another than the
 * builder stands at `commit` (7 to 64 hex, as the mark takes it).
 */
export function unreviewedDetail(args: {
  issueRef: string;
  commit: string | null;
  reviews: readonly StoredReview[];
  builders: Builders;
}): string | null {
  const { commit, reviews } = args;
  const at = commit ? reviews.filter((r) => r.head.startsWith(commit.toLowerCase())) : [];
  const counted = at.filter(
    (r) => reviewerRefusal(args.issueRef, r.reviewer, args.builders) === null,
  );
  if (counted.some((r) => r.result === 'pass')) return null;
  const why =
    'this project declares `validation.mergeCheck: required`, and its merge asks a review';
  let found: string;
  if (!commit) {
    found =
      'the mark names no commit and the issue records none, so no review can be matched to it';
  } else if (counted.length) {
    const failed = counted.at(-1)?.failed ?? [];
    found = `the review at ${commit} failed ${failed.slice(0, 8).join(', ')}`;
  } else if (at.length) {
    found = `the only review at ${commit} was recorded by the building run, and a review is never the builder's`;
  } else {
    const heads = [...new Set(reviews.map((r) => r.head.slice(0, 12)))];
    found = `no review is recorded at ${commit}${heads.length ? ` (reviews stand at ${heads.join(', ')})` : ''}`;
  }
  return `${why}, and ${found}. A run other than the building run, or a person, records it with \`POST /api/issues/:id/review\` at the commit that lands. Nothing was marked`;
}
