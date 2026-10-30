/**
 * Fast delivery's rules (REQ-79), pure: what a debt record may carry, what a cleanup report owes the
 * ledger, which changes wait for a green cleanup, and the brief a cleanup run starts with. `store.ts`
 * and `service.ts` read and write around them.
 */

import {
  type CleanupRefusalCode,
  type CleanupReportRequest,
  type DebtItem,
  HOLDING_RATING,
  type Impact,
} from '@forge/contracts/cleanup';
import { MERGE_CLEANUP_PENDING } from '@forge/contracts/merge-check';

export interface CleanupRefusal {
  code: CleanupRefusalCode;
  path: string;
  detail: string;
}

/** Why a project's fast delivery is off, in the words every door that refuses for it says. */
export const FAST_DELIVERY_OFF_DETAIL =
  "this project turned fast delivery off (`delivery.fast: false` in its project document), so a red is fixed in the issue that met it and nothing is left as cleanup debt (REQ-79 BC-1). Turn it back on with `delivery.fast: true`, or drop the setting: fast delivery is every project's default";

/** Each red rated high among `items`: it holds its issue, so it is never debt (BC-3). */
export function debtRefusals(items: readonly DebtItem[]): CleanupRefusal[] {
  return items.flatMap((d, i) =>
    d.kind === 'red' && d.impact.rating === HOLDING_RATING
      ? [
          {
            code: 'DEBT_RED_HOLDS_THE_ISSUE' as const,
            path: `/items/${i}/impact/rating`,
            detail: `\`${d.check ?? d.where}\` is a red you rate ${HOLDING_RATING}: a red rated ${HOLDING_RATING} holds the issue and is fixed in it, whoever caused it, so it is never cleanup debt (REQ-79 BC-3). Fix it in this change, or, where it is not that severe, rate it low or medium with why. Nothing was recorded`,
          },
        ]
      : [],
  );
}

/** An open debt as a report is checked against it: its id and where it is, for the refusal's words. */
export interface OpenDebt {
  id: string;
  where: string;
  rating: Impact['rating'];
}

/** One issue a report names as covered, as read now: its key and its current rating, if any. */
export interface CoverCandidate {
  ref: string;
  issueId: string | null;
  key: string | null;
  rating: Impact['rating'] | null;
}

/**
 * Why a cleanup report cannot be kept, each by name (BC-9): a debt it names that is not open on this
 * project, a debt named twice, an open debt it names neither cleared nor remaining, a red report that
 * covers anything, and a covered issue not rated high now.
 */
export function reportRefusals(
  report: CleanupReportRequest,
  open: readonly OpenDebt[],
  covers: readonly CoverCandidate[],
): CleanupRefusal[] {
  const out: CleanupRefusal[] = [];
  const openIds = new Set(open.map((d) => d.id.toLowerCase()));
  const named = [
    ...report.cleared.map((c, i) => ({ id: c.debt.toLowerCase(), at: `/cleared/${i}/debt` })),
    ...report.remains.map((r, i) => ({ id: r.debt.toLowerCase(), at: `/remains/${i}/debt` })),
  ];
  const seen = new Set<string>();
  for (const n of named) {
    if (!openIds.has(n.id)) {
      out.push({
        code: 'CLEANUP_DEBT_UNKNOWN',
        path: n.at,
        detail: `debt ${n.id} is not open on this project: it was never recorded here, or a cleanup report already cleared it. Read the ledger (GET /api/projects/:id/debts) and name only what it lists open`,
      });
      continue;
    }
    if (seen.has(n.id)) {
      out.push({
        code: 'CLEANUP_DEBT_NAMED_TWICE',
        path: n.at,
        detail: `debt ${n.id} is named twice: each debt is cleared or remains, once`,
      });
    }
    seen.add(n.id);
  }
  const unnamed = open.filter((d) => !seen.has(d.id.toLowerCase()));
  if (unnamed.length > 0) {
    out.push({
      code: 'CLEANUP_REPORT_INCOMPLETE',
      path: '/remains',
      detail: `a cleanup report says what it cleared and what remains, and why, for every debt open on the project (REQ-79 BC-9); it names none of ${unnamed.map((d) => `${d.id} (${d.where})`).join(', ')}. Name each in \`cleared\` with how, or in \`remains\` with why. Nothing was recorded`,
    });
  }
  if (report.result !== 'green' && covers.length > 0) {
    out.push({
      code: 'CLEANUP_COVERS_RED',
      path: '/covers',
      detail:
        'only a green cleanup lets a change rated high reach production (REQ-79 BC-5), and this report is red: send `covers` only with `result: green`. Nothing was recorded',
    });
  }
  for (const [i, c] of covers.entries()) {
    if (c.issueId === null) {
      out.push({
        code: 'CLEANUP_COVERS_NOT_HIGH',
        path: `/covers/${i}`,
        detail: `${c.ref} is not an issue of this project. Nothing was recorded`,
      });
    } else if (c.rating !== HOLDING_RATING) {
      out.push({
        code: 'CLEANUP_COVERS_NOT_HIGH',
        path: `/covers/${i}`,
        detail: `${c.key ?? c.ref} is ${c.rating ? `rated ${c.rating}` : 'not rated'}, and a cleanup covers only a change rated ${HOLDING_RATING}, which alone waits for one (REQ-79 BC-5). Leave it out of \`covers\`. Nothing was recorded`,
      });
    }
  }
  return out;
}

/** An issue whose current rating is high, as the hold reads it. */
export interface RatedIssue {
  issueId: string;
  impact: Impact;
  ratedAt: Date;
}

/**
 * The issues that wait for a green cleanup before production (BC-5, BC-6): rated high now, and no
 * green report since that rating covers them. A lower rating, or none, waits for nothing.
 */
export function waitingOnCleanup(
  rated: readonly RatedIssue[],
  coveredAt: ReadonlyMap<string, Date>,
): RatedIssue[] {
  return rated.filter((r) => {
    if (r.impact.rating !== HOLDING_RATING) return false;
    const covered = coveredAt.get(r.issueId);
    return !covered || covered < r.ratedAt;
  });
}

/** One open debt as the cleanup brief lists it. */
export interface BriefDebt {
  id: string;
  kind: string;
  check: string | null;
  where: string;
  rating: string;
  issueKey: string | null;
}

/**
 * The brief a cleanup run starts with (BC-7, BC-9): what is open, which changes rated high wait on it,
 * how to work it and the report it owes, with the fire it answers.
 */
export function cleanupBrief(args: {
  projectId: string;
  fireId: string;
  debts: readonly BriefDebt[];
  waiting: readonly { key: string; reason: string }[];
}): string {
  const { projectId, fireId } = args;
  const debts = args.debts.length
    ? args.debts
        .map(
          (d) =>
            `- ${d.id} [${d.kind}${d.check ? ` ${d.check}` : ''}, ${d.rating}] ${d.where}${d.issueKey ? ` (seen on ${d.issueKey})` : ''}`,
        )
        .join('\n')
    : '- none recorded';
  const waiting = args.waiting.length
    ? args.waiting.map((w) => `- ${w.key}: ${w.reason}`).join('\n')
    : '- none';
  return [
    "You are this project's cleanup run (REQ-79), started by its cleanup window. You run on a slot of your own and never take a delivery run's; leave delivery work to the delivery runs.",
    '',
    `Open cleanup debt (GET /api/projects/${projectId}/debts reads it whole):`,
    debts,
    '',
    'Changes rated high impact waiting on a green cleanup before production:',
    waiting,
    '',
    'Do this:',
    "1. In a new worktree off the branch this project's work lands on, clear the debt above and any CI red on that branch, and simplify the code you touch. Land each fix the way this project lands work.",
    "2. Run the project's checks at the head you leave, and record any new debt you find but do not clear: POST /api/projects/" +
      `${projectId}/debts { items: [{ kind, check?, where, detail, impact: { type, rating, reason } }] }.`,
    `3. Report once, last: POST /api/projects/${projectId}/cleanup-reports { fire: "${fireId}", base: { branch, sha: <the head you leave> }, result: green | red, ci?: <run url>, cleared: [{ debt, how }], remains: [{ debt, why }], covers: [<each waiting key above whose merge the green head carries, checked with git merge-base --is-ancestor>] }.`,
    'Every open debt is named once, cleared with how or remaining with why; only a green report covers anything.',
  ].join('\n');
}

/** The cleanup window as a landing refusal names it. */
export interface WindowSaid {
  scheduleId: string;
  cron: string;
  timeZone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
}

/** The newest cleanup report on the base, as the landing rule reads it. */
export interface LastReport {
  id: string;
  result: 'green' | 'red';
  branch: string;
  sha: string;
  reportedAt: Date;
}

const NAMED_DEBTS = 8;

function windowWords(w: WindowSaid | null): string {
  if (!w) return 'The project has no cleanup window saved yet: rating a change high saves one.';
  const at = `${w.cron}${w.timeZone ? ` ${w.timeZone}` : ' UTC'}`;
  if (!w.enabled) {
    return `The cleanup window (schedule ${w.scheduleId}, ${at}) is disabled: a person enables it, or runs the cleanup by hand (POST /api/projects/:id/schedules/${w.scheduleId}/run).`;
  }
  return `The cleanup window is schedule ${w.scheduleId} (${at}), next run ${w.nextRunAt ?? 'not scheduled'}; it can be run now with POST /api/projects/:id/schedules/${w.scheduleId}/run.`;
}

/** A landing the cleanup holds, refused by name. */
export interface LandingRefusal {
  code: typeof MERGE_CLEANUP_PENDING;
  path: string;
  detail: string;
}

/**
 * Whether a change may land (REQ-79 r4 BC-5): on a project delivering fast whose production deploys on
 * land, landing is reaching production, so a change rated high lands only once a cleanup has left the
 * base green. It passes when the latest cleanup report on the base is green, that report is newer than
 * the last change rated high that landed, and no open debt is rated high (the report's own `debts`
 * included). A medium or low open debt never blocks. It refuses by name on a red last report, on no
 * report since the last high landing, and on each open high debt, naming it. A project that never
 * rated a change high and never filed a report has left nothing red, so it passes. Every lower
 * rating, an unrated change, a project that promotes and one that turned fast delivery off land as
 * they did.
 */
export function landingRefusal(args: {
  fast: boolean;
  onLand: boolean;
  rating: Impact | null;
  issueRef: string;
  open: readonly OpenDebt[];
  ownHigh: number;
  last: LastReport | null;
  lastHighLandedAt: Date | null;
  window: WindowSaid | null;
}): LandingRefusal | null {
  const { rating, last, lastHighLandedAt } = args;
  if (!args.fast || !args.onLand || rating?.rating !== HOLDING_RATING) return null;
  const why: string[] = [];
  const high = args.open.filter((d) => d.rating === HOLDING_RATING);
  if (high.length > 0) {
    const shown = high.slice(0, NAMED_DEBTS).map((d) => `${d.id} (${d.where})`);
    const more = high.length > NAMED_DEBTS ? `, and ${high.length - NAMED_DEBTS} more` : '';
    why.push(
      `the base carries ${high.length} open cleanup debt rated high: ${shown.join(', ')}${more}`,
    );
  }
  if (args.ownHigh > 0) {
    why.push(`this report would leave ${args.ownHigh} new cleanup debt rated high (\`debts\`)`);
  }
  if (last && last.result !== 'green') {
    why.push(
      `the last cleanup report ${last.id} is red at ${last.sha.slice(0, 12)} on ${last.branch}`,
    );
  } else if (lastHighLandedAt && (!last || last.reportedAt <= lastHighLandedAt)) {
    why.push(
      `no cleanup report on this base since the last change rated high landed (${lastHighLandedAt.toISOString()})`,
    );
  }
  if (why.length === 0) return null;
  return {
    code: MERGE_CLEANUP_PENDING,
    path: '/impact',
    detail: `${args.issueRef} is rated high impact (${rating.type}: ${rating.reason}) and this project deploys on land, so landing it is reaching production (REQ-79 BC-5): a change rated high lands only once a cleanup has left the base green, and ${why.join('; ')}. ${windowWords(args.window)} Land after a green cleanup report on this base; a medium or low open debt does not block, and low and medium changes land without waiting. Nothing was recorded`,
  };
}
