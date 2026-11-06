/**
 * Fast delivery's rules (REQ-79), pure: what a debt record may carry, what a cleanup report owes the
 * ledger, what the base owes the audit, and the brief a cleanup run starts with. `store.ts` and
 * `service.ts` read and write around them.
 */

import {
  CLEANUP_WINDOW_DEFAULT,
  type CleanupRefusalCode,
  type CleanupReportRequest,
  type DebtItem,
  HOLDING_RATING,
  type Impact,
} from '@forge/contracts/cleanup';
import { guideRef } from '../guides/index.js';

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
  /** Carried under a priced amnesty (BC-10): it remains, and never turns a report red. */
  carried: boolean;
}

/**
 * Why a cleanup report cannot be kept, each by name (BC-9): a debt it names that is not open on this
 * project, a debt named twice, an open debt it names neither cleared nor remaining, and a result its
 * ledger contradicts.
 */
export function reportRefusals(
  report: CleanupReportRequest,
  open: readonly OpenDebt[],
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
  const resultFault = resultDisagreement(report, open);
  if (resultFault) out.push(resultFault);
  return out;
}

/**
 * A report is green exactly when every debt it leaves is carried (BC-10), so its result is read from
 * the ledger and never from the run's own judgement: a green leaving debt nobody carries, or a red
 * leaving only carried debt, is refused, naming which.
 */
function resultDisagreement(
  report: CleanupReportRequest,
  open: readonly OpenDebt[],
): CleanupRefusal | null {
  const carried = new Set(open.filter((d) => d.carried).map((d) => d.id.toLowerCase()));
  const uncarried = report.remains.filter((r) => !carried.has(r.debt.toLowerCase()));
  if (report.result === 'green' && uncarried.length > 0) {
    return {
      code: 'CLEANUP_RESULT_DISAGREES',
      path: '/result',
      detail: `a cleanup report is green exactly when every debt it leaves is carried (REQ-79 BC-10), and this one leaves ${uncarried.map((r) => r.debt).join(', ')}, which nobody carries. Clear it, report red, or have its amnesty priced (POST /api/projects/:id/debts/:debt/carry { trades, costs, endsWhen }) first. Nothing was recorded`,
    };
  }
  if (report.result === 'red' && uncarried.length === 0) {
    return {
      code: 'CLEANUP_RESULT_DISAGREES',
      path: '/result',
      detail: `a cleanup report is red only for a debt it leaves that nobody carries (REQ-79 BC-10), and this one leaves ${report.remains.length ? 'only carried debt' : 'no debt'}. Record what is red as debt (POST /api/projects/:id/debts) and leave it in \`remains\`, or report green. Nothing was recorded`,
    };
  }
  return null;
}

/** An issue's current rating, as the mark's owed merge check reads it. */
export interface RatedIssue {
  issueId: string;
  impact: Impact;
  ratedAt: Date;
}

/** One open debt as the cleanup brief lists it. */
export interface BriefDebt {
  id: string;
  kind: string;
  check: string | null;
  where: string;
  rating: string;
  issueKey: string | null;
  /** What was recorded about it when it was left (BC-3). */
  detail: string;
  /** The priced amnesty it is carried under, with who priced it (BC-10, ISS-839). */
  carried: { trades: string; costs: string; endsWhen: string; by: string | null } | null;
  /** What was found about it since, oldest first, each in its giver's name (ISS-839). */
  evidence: readonly { evidence: string; by: string | null; at: string }[];
}

const whoGave = (by: string | null) => by ?? 'someone no longer on Forge';

/** One open debt as the brief lists it: the line, its detail, its amnesty and its evidence. */
function briefDebt(d: BriefDebt): string {
  const lines = [
    `- ${d.id} [${d.kind}${d.check ? ` ${d.check}` : ''}, ${d.rating}] ${d.where}${d.issueKey ? ` (seen on ${d.issueKey})` : ''}`,
    `  detail: ${d.detail}`,
  ];
  if (d.carried) {
    lines.push(
      `  CARRIED, a priced amnesty by ${whoGave(d.carried.by)}: trades ${d.carried.trades}; costs ${d.carried.costs}; ends when ${d.carried.endsWhen}`,
    );
  }
  for (const e of d.evidence) {
    lines.push(`  evidence from ${whoGave(e.by)}, ${e.at.slice(0, 10)}: ${e.evidence}`);
  }
  return lines.join('\n');
}

/**
 * What landed on the base since the project's last cleanup report (ISS-1050, REQ-79 BC-20): a range
 * from the report's head (null where none was ever filed) to the branch head, nothing since, the
 * window off (the trigger never reaches past it), or why the base could not be read.
 */
export type Landed =
  | { kind: 'landed'; branch: string; from: string | null; head: string }
  | { kind: 'none'; branch: string; head: string }
  | { kind: 'off'; why: string }
  | { kind: 'unread'; why: string };

/** What landed, as the brief and a fire that starts nothing say it. */
export function landedWords(landed: Landed): string {
  switch (landed.kind) {
    case 'landed':
      return landed.from
        ? `What landed on ${landed.branch} since the last cleanup report: ${landed.from}..${landed.head} (git log ${landed.from}..${landed.head}).`
        : `This project has no cleanup report yet on ${landed.branch}: review what landed recently, up to its head ${landed.head}, and your report gives the next window its base.`;
    case 'none':
      return `nothing landed on ${landed.branch} since the last cleanup report (its head is ${landed.head})`;
    case 'off':
    case 'unread':
      return landed.why;
  }
}

/**
 * The brief a cleanup run starts with (BC-7, BC-9, BC-20): what is open, what landed since the last
 * report, the audit guide that says how to work it (BC-23), and the report it owes, with the fire it
 * answers.
 */
export function cleanupBrief(args: {
  projectId: string;
  fireId: string;
  debts: readonly BriefDebt[];
  landed: Landed;
}): string {
  const { projectId, fireId } = args;
  const landed =
    args.landed.kind === 'landed'
      ? landedWords(args.landed)
      : `Nothing to review: ${landedWords(args.landed)}.`;
  const debts = args.debts.length ? args.debts.map(briefDebt).join('\n') : '- none recorded';
  return [
    "You are this project's cleanup run (REQ-79), started by its cleanup window: the Audit stage of Product → Delivery → Release → Audit, a job of its own. You run on a slot of your own and never take a delivery run's; leave delivery work to the delivery runs.",
    '',
    `Open cleanup debt (GET /api/projects/${projectId}/debts reads it whole):`,
    debts,
    '',
    landed,
    '',
    'Do this:',
    `1. Read ${guideRef('cleanup-audit')} first: it is how this run works. In a new worktree off the branch this project's work lands on, review what landed above and how it ran, clear the debt above and any CI red on that branch, and return to Product what would change the product, as that guide says. Land each fix the way this project lands work.`,
    "2. Run the project's checks at the head you leave, and record any new debt you find but do not clear: POST /api/projects/" +
      `${projectId}/debts { items: [{ kind, check?, where, detail, impact: { type, rating, reason } }] }.`,
    `3. Report once, last: POST /api/projects/${projectId}/cleanup-reports { fire: "${fireId}", base: { branch, sha: <the full 40-hex sha of the head you leave, pushed to that branch> }, result: green | red, ci?: <run url>, cleared: [{ debt, how }], remains: [{ debt, why }] }. Core reads base.sha on the project's source host and refuses one that branch does not hold (CLEANUP_BASE_NOT_ON_BRANCH); a report you must correct is filed again with the same fire, and the later one supersedes it.`,
    'Every open debt is named once, cleared with how or remaining with why. Weigh the evidence given on a debt before you work it; what you find yourself, keep on it: POST /api/projects/' +
      `${projectId}/debts/<debt>/evidence { evidence }.`,
    'The result is not yours to judge (REQ-79 BC-10): it is green exactly when every debt you leave in remains is CARRIED above, and red when you leave one that is not. Core refuses any other result (CLEANUP_RESULT_DISAGREES). A carried debt still remains until it is cleared, and never makes a report red; carrying a debt is not yours either.',
    '',
    'This run is headless: once your turn ends nothing wakes it, and no notification of a CI run, a background task or a message ever reaches it. So never end your turn waiting on anything; your turn ends only after the report is posted.',
    '- A CI run on the head you leave: reuse one already started or finished there (gh run list --branch <branch> --commit <sha>) before starting another, and wait for it inside this turn: gh run watch <run id> --exit-status.',
    '- A run that cannot finish in this turn: report what the head shows now, red, with that run recorded as debt and left in remains, never nothing.',
  ].join('\n');
}

/** The cleanup window, as the ledger and the brief name it. */
export interface WindowSaid {
  scheduleId: string;
  cron: string;
  timeZone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
}

/** The newest cleanup report on the base, as the audit's owed report reads it. */
export interface LastReport {
  id: string;
  result: 'green' | 'red';
  branch: string;
  sha: string;
  reportedAt: Date;
}

const windowAt = (w: WindowSaid) => `${w.cron}${w.timeZone ? ` ${w.timeZone}` : ' UTC'}`;

/**
 * Where no cleanup window is on, that said plainly with who turns one on (ISS-1049, REQ-79 BC-19):
 * none saved, or one a person disabled. Null where the project's window is on. Debt is recorded
 * either way; no door makes or enables a window for the project.
 */
export function windowOffWords(projectId: string, w: WindowSaid | null): string | null {
  const waits = 'so no cleanup run starts here; debt is still recorded and waits in this ledger.';
  if (!w) {
    const { cron, name } = CLEANUP_WINDOW_DEFAULT;
    return `No cleanup window is on for this project, ${waits} Forge never makes one: a project admin turns one on (POST /api/schedules { projectId: "${projectId}", name: "${name}", cron: "${cron}", kind: "cleanup" }).`;
  }
  if (w.enabled) return null;
  return `The cleanup window (schedule ${w.scheduleId}, ${windowAt(w)}) is off, ${waits} A project admin turns it on (PUT /api/schedules/${w.scheduleId} { enabled: true }), or runs the cleanup once by hand (POST /api/schedules/${w.scheduleId}/run).`;
}

/**
 * What the base owes the audit after a change rated high landed (BC-5): `red` where its last cleanup
 * report is red, `stale` where no report follows the last change rated high that landed, else null.
 * Nothing waits on it: the change has landed, and the cleanup window starts a run on it.
 */
export function reportOwed(
  last: LastReport | null,
  lastHighLandedAt: Date | null,
): 'red' | 'stale' | null {
  if (last && last.result !== 'green') return 'red';
  if (lastHighLandedAt && (!last || last.reportedAt <= lastHighLandedAt)) return 'stale';
  return null;
}
