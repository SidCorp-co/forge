/**
 * The guards the issue machine (`@forge/contracts/issue-machine:ISSUE_MACHINE`) names, each refusing
 * by name. `apply-transition.ts` asks `edgeFault` before anything is written; the kernel transition
 * runs `issueGuards` under its row lock, so a guard reads the row the move will change through the
 * move's transaction. What a guard needs from outside the issue's rows (the project document, the
 * actor's permissions, the storefront drafts its verdicts name) is read once before the lock
 * (`readIssueMoveFacts`) and handed in: no guard opens a second connection or calls a provider while
 * the lock is held.
 *
 *   into               condition                                                code
 *   any (edge)         the move is an edge of the lifecycle                      ILLEGAL_TRANSITION
 *   open, from draft   the actor holds `issues.admit`                            PERMISSION_FORBIDDEN
 *   in_progress        a run or lease holds it; nothing admissible holds out     NO_HOLDER, ISSUE_BLOCKED, WORKFLOW_DESIGN_NOT_APPROVED
 *   approved           plan and criteria written; the actor holds `plans.approve`  PLAN_REQUIRED
 *                      where the project document sets `plan.approval.required`
 *   awaiting_release   the merge is recorded (a landing moves no status)          MERGE_NOT_RECORDED
 *                      every criterion's latest verdict passes, with an          NO_WORK_EVIDENCE,
 *                      admissible identity, recorded after the latest reopen     VERDICT_IDENTITY_REQUIRED, VERDICT_PREDATES_REOPEN, VERDICT_IDENTITY_NOT_ADMISSIBLE, VERDICT_DRAFT_SUPERSEDED, VERDICT_UNCORROBORATED
 *                      (a project document with `delivery.verdictsRequired: false` passes the move
 *                      and the move's record says `verdicts-waived`), and its     REQUIREMENT_CHANGED_SINCE_PLAN
 *                      requirement has not changed since its plan
 *   closed             only from awaiting_release, by a release that claimed it  CLOSE_ONLY_BY_RELEASE
 *                      (a release batch or a recorded release), merge recorded   CLOSE_REQUIRES_SHIPPED
 *
 *   needs_info         a question (the reason) and its kind                      TRANSITION_REASON_REQUIRED,
 *                                                                                WAITING_KIND_REQUIRED
 *   on_hold, reopen    a reason                                                  TRANSITION_REASON_REQUIRED
 *   dropped            a reason                                                  VOID_REASON_REQUIRED
 */

import { verdictsRequiredOf } from '@forge/contracts/delivery-policy';
import type { IssueTransitionRefusalCode } from '@forge/contracts/issue-machine';
import {
  ISSUE_ADMIT_PERMISSION,
  ISSUE_MACHINE,
  type IssueGuard,
  PARK_STATUSES,
} from '@forge/contracts/issue-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { Refusal } from '../lib/refusal.js';
import { isRefusal } from '../lib/refusal.js';
import type { Guard, GuardInput } from '../lifecycle/index.js';
import {
  type PermissionFacts,
  permissionFactsOf,
  permissionRefusal,
} from '../permissions/index.js';
import { refuseHeldTake } from './blocked-by.js';
import type { CurrentDrafts } from './criteria/storefront-draft.js';
import { mergeNotRecorded } from './merged-at.js';
import { isDispatchGateError, planDriftOf, readProjectDocument } from './ports.js';
import {
  type CriteriaEvidence,
  readMoveDrafts,
  type SourceType,
  unpassedCriteria,
} from './release-evidence.js';
import { isBlankPlan } from './transition-evidence.js';
import { edgeFault, quote } from './transition-faults.js';
import { issueHolder } from './work-state.js';

export type GuardCode = Exclude<
  IssueTransitionRefusalCode,
  'NO_OP' | 'STALE_TRANSITION' | 'WAITING_KIND_NOT_APPLICABLE' | 'ISSUE_ARCHIVED' | 'OPEN_QUESTIONS'
>;

export interface GuardFault {
  code: GuardCode;
  detail: string;
  details: Record<string, unknown>;
}

export interface GuardContext {
  issue: { id: string; projectId: string };
  from: IssueStatus;
  to: IssueStatus;
  /** The status the park being left was entered from (`issue_work_state.left_status`), or null. */
  leftStatus?: IssueStatus | null | undefined;
  agency: ActorAgency;
  /** The account the move is made as: the user, or the owner of the device making it. */
  actorUserId: string;
  transitionReason?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  executor: Pick<Tx, 'select' | 'execute'>;
  facts: IssueMoveFacts;
  /** Called with the refusal a move passed only because the project does not require verdicts. */
  onVerdictsWaived?: ((waived: GuardFault) => void) | undefined;
}

/** What the guards read from outside the issue's rows, read before the move takes its lock. */
interface IssueMoveFacts {
  /** The project document sets `plan.approval.required`. */
  planApprovalRequired: boolean;
  /** The project document requires verdicts for a release (`delivery.verdictsRequired`). */
  verdictsRequired: boolean;
  /** The project document's source type, which decides which verdict identities are admissible. */
  source: SourceType;
  /** The mover's role and grants on the project. */
  permissions: PermissionFacts;
  /** The drafts the criteria's storefront verdicts name, as the source holds them now. */
  drafts: CurrentDrafts;
}

export async function readIssueMoveFacts(args: {
  issue: { id: string; projectId: string };
  actorUserId: string;
  to: IssueStatus;
}): Promise<IssueMoveFacts> {
  const { issue } = args;
  const document = (await readProjectDocument(issue.projectId))?.document;
  return {
    planApprovalRequired: document?.plan?.approval.required === true,
    verdictsRequired: verdictsRequiredOf(document?.delivery),
    source: document?.source.type ?? null,
    permissions: await permissionFactsOf(args.actorUserId, issue.projectId),
    drafts: await readMoveDrafts(issue, args.to),
  };
}

// cm:why a person's move is refused as an agent's: issue-lifecycle rev 3 puts the condition on the edge, not the actor (ISS-104 decision)
async function heldTakeGuard(ctx: GuardContext): Promise<GuardFault | null> {
  try {
    await refuseHeldTake(ctx.executor, ctx.issue.id, 'a move to `in_progress`');
    return null;
  } catch (err) {
    if (isRefusal(err, 'ISSUE_BLOCKED')) {
      return {
        code: 'ISSUE_BLOCKED',
        detail: err.refusals.map((r) => r.detail).join(' '),
        details: { from: ctx.from, to: ctx.to },
      };
    }
    if (isDispatchGateError(err)) {
      return {
        code: err.code,
        detail: err.message.replace(`${err.code}: `, ''),
        details: { from: ctx.from, to: ctx.to, blocked: err.blocked },
      };
    }
    throw err;
  }
}

/** in_progress, entered by a claim: a run or a lease holds the issue. */
async function holderGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const holder = await issueHolder(ctx.executor, ctx.issue);
  if (holder) return null;
  return {
    code: 'NO_HOLDER',
    detail: `\`in_progress\` says a run is working this issue, and nothing holds it: no live lease on its work state, and no job, run or fleet lease over it. Claim it first (a lease, or a run session), then move it — an issue nobody holds stays at ${quote(ctx.from)} where a master can take it.`,
    details: { from: ctx.from, to: ctx.to },
  };
}

/** approved, the plan checkpoint: a plan and criteria, and plans.approve where the project says so. */
async function planGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const rows = (await ctx.executor.execute(sqlPlanRow(ctx.issue.id))) as unknown as Array<{
    plan: string | null;
    acceptance_criteria: string | null;
  }>;
  const row = rows[0];
  const missing = [
    isBlankPlan(row?.plan) ? 'plan' : null,
    isBlankPlan(row?.acceptance_criteria) ? 'acceptanceCriteria' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    return {
      code: 'PLAN_REQUIRED',
      detail: `\`approved\` is the plan checkpoint the next run builds from, and this issue has no ${missing.map(quote).join(' and ')} written. Write ${missing.length === 1 ? 'it' : 'them'} on the issue, then move it.`,
      details: { from: ctx.from, to: ctx.to, missing },
    };
  }
  if (ctx.facts.planApprovalRequired) {
    const denied = permissionRefusal(
      ctx.facts.permissions,
      'plans.approve',
      'moving an issue to `approved` (project document `plan.approval.required`)',
    );
    if (denied) {
      return {
        code: denied.code,
        detail: `${denied.detail} Ask for it: park at \`needs_info\` with \`waitingKind: "needs_decision"\` naming the plan, and a holder of ${denied.permission} moves it once it is back.`,
        details: {
          from: ctx.from,
          to: ctx.to,
          permission: denied.permission,
          scope: denied.scope,
          rule: 'plan.approval.required',
        },
      };
    }
  }
  return null;
}

// A flagged issue cannot reach awaiting_release until it is re-planned against the current head
// (requirement-to-delivery, step `impact`).
async function planDriftGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const drift = await planDriftOf(ctx.executor, ctx.issue.id);
  if (!drift?.changed) return null;
  return {
    code: 'REQUIREMENT_CHANGED_SINCE_PLAN',
    detail: `${quote(ctx.to)} is reached only by work planned against its requirement as it stands: ${drift.detail} Rewrite the plan (it records the current revision and baseline), then move it.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      requirement: drift.key,
      plannedRevision: drift.plannedRevision,
      currentRevision: drift.currentRevision,
      repinned: drift.repinned,
    },
  };
}

/**
 * awaiting_release: every criterion's latest verdict passes, says what it
 * held in, and was recorded after the issue's latest reopen. A project document with
 * `delivery.verdictsRequired: false` lets the move through and reports what it would have refused,
 * so the move's record says the verdicts were waived and not that they held.
 */
async function verdictGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const fault = await verdictFault(ctx, ctx.facts.source);
  if (fault === null || ctx.facts.verdictsRequired) return fault;
  ctx.onVerdictsWaived?.(fault);
  return null;
}

async function verdictFault(ctx: GuardContext, source: SourceType): Promise<GuardFault | null> {
  const found = await unpassedCriteria(ctx.executor, ctx.issue, source, ctx.facts.drafts);
  const into = quote(ctx.to);
  if (found.kind === 'no-criteria') {
    return {
      code: 'NO_WORK_EVIDENCE',
      detail: `${into} says every criterion holds a passing verdict, and this issue has no criteria for a verdict to hold on. Write them (\`PUT /api/issues/:id/criteria\`, or numbered \`acceptanceCriteria\`) and record a verdict on each (\`POST /api/issues/:id/verdicts\`), then move it.`,
      details: { from: ctx.from, to: ctx.to, criteria: [] },
    };
  }
  if (found.unpassed.length > 0) {
    const named = found.unpassed
      .map((u) => `${u.criterion} (${u.verdict === null ? 'no verdict' : `\`${u.verdict}\``})`)
      .join(', ');
    return {
      code: 'NO_WORK_EVIDENCE',
      detail: `${into} says every criterion holds a passing verdict, and criteria ${named} do not. A \`skipped\` or \`fail\` verdict never passes. Record a passing verdict on each, then move it.`,
      details: { from: ctx.from, to: ctx.to, unpassed: found.unpassed },
    };
  }
  if (found.predateReopen.length > 0) {
    const at = found.reopenedAt?.toISOString() ?? 'its reopen';
    return {
      code: 'VERDICT_PREDATES_REOPEN',
      detail: `this issue was reopened at ${at}, and the passing verdicts on criteria ${found.predateReopen.join(', ')} were recorded before that: a reopen says the work was not right, so evidence from before it is not current. Record a new verdict on each against the work done since the reopen, then move it.`,
      details: {
        from: ctx.from,
        to: ctx.to,
        reopenedAt: found.reopenedAt?.toISOString() ?? null,
        predateReopen: found.predateReopen,
      },
    };
  }
  if (found.unidentified.length > 0) {
    return {
      code: 'VERDICT_IDENTITY_REQUIRED',
      detail: `a passing verdict says what it held in — a whole commit sha, a runtime, a design revision (\`<flow> rev <n>\`) or a contract version (\`<ref>@<version>\`) — and the latest verdict on criteria ${found.unidentified.join(', ')} names none the gate accepts (a backfilled \`commit_unresolved\` abbreviation is not one). Record each again with its identity, then move it.`,
      details: { from: ctx.from, to: ctx.to, unidentified: found.unidentified },
    };
  }
  return storefrontDraftFault(ctx, found, source);
}

export function storefrontDraftFault(
  ctx: GuardContext,
  found: Extract<CriteriaEvidence, { kind: 'criteria' }>,
  source: SourceType,
): GuardFault | null {
  if (found.inadmissible.length > 0) {
    const held = source === null ? 'declares no project document' : `has source \`${source}\``;
    return {
      code: 'VERDICT_IDENTITY_NOT_ADMISSIBLE',
      detail: `the latest verdict on criteria ${found.inadmissible.join(', ')} names a storefront draft, and this project ${held}: a draft stands in for a landed commit only where the work lives on a storefront (\`source.type: "storefront"\`). Record each against the commit or runtime it was judged at, then move it.`,
      details: { from: ctx.from, to: ctx.to, source, inadmissible: found.inadmissible },
    };
  }
  if (found.superseded.length > 0) {
    const named = found.superseded.map((u) => `${u.criterion} (${u.note})`).join('; ');
    return {
      code: 'VERDICT_DRAFT_SUPERSEDED',
      detail: `a storefront draft counts only while it is the draft the storefront source holds, and the latest verdict on criteria ${named}. Judge each again at the draft \`forge_storefront_target\` reports now, record it naming that draft version, then move it.`,
      details: { from: ctx.from, to: ctx.to, superseded: found.superseded },
    };
  }
  if (found.uncorroborated.length > 0) {
    const named = found.uncorroborated.map((u) => `${u.criterion} (${u.note})`).join('; ');
    return {
      code: 'VERDICT_UNCORROBORATED',
      detail: `a storefront draft counts once the storefront source reads it back as the draft it holds, and the latest verdict on criteria ${named} was not. Record each again naming the draft version \`forge_storefront_target\` reports now, then move it.`,
      details: { from: ctx.from, to: ctx.to, uncorroborated: found.uncorroborated },
    };
  }
  return null;
}

/** closed: a release closes what it claimed (`issues.release_batch_run_id`), and nothing else does. */
async function releaseGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const rows = (await ctx.executor.execute(
    sql`SELECT release_batch_run_id FROM issues WHERE id = ${ctx.issue.id}`,
  )) as unknown as Array<{ release_batch_run_id: string | null }>;
  if (rows[0]?.release_batch_run_id) return null;
  return {
    code: 'CLOSE_ONLY_BY_RELEASE',
    detail: `an issue closes only through a release, and no release has claimed this one. Finish a release batch carrying it (\`POST /api/projects/${ctx.issue.projectId}/release-batches\`), or record the release that already happened (\`POST /api/projects/${ctx.issue.projectId}/release-records\`); either closes every issue it carries.`,
    details: { from: ctx.from, to: ctx.to },
  };
}

/** A guard's fault as the kernel transition carries it: the refusal, with its details beside it. */
function refusalOf(fault: GuardFault | null): Refusal | null {
  if (!fault) return null;
  return {
    code: fault.code,
    path: '/status',
    detail: fault.detail,
    details: fault.details,
  } as Refusal;
}

/** The guards the issue machine's edges into a status name, read off its first lifecycle edge
 *  from a working status: what a park with no recorded left status owes on the way out. */
function entryGuardsOf(to: IssueStatus): readonly string[] {
  const entry = ISSUE_MACHINE.edges.find(
    (e) => e.to === to && !e.recovery && !PARK_STATUSES.includes(e.from),
  );
  return entry?.guards ?? [];
}

type IssueGuardContext = Omit<GuardContext, 'from' | 'to' | 'executor'> & {
  /** The run a recovery move hands the issue back from: its own hold is the one ending. */
  recoveringRunId?: string | null | undefined;
};

/** Each guard the issue machine names, bound to the move being made. */
export function issueGuards(base: IssueGuardContext): Record<IssueGuard, Guard<'issue'>> {
  const ctxOf = (input: GuardInput<'issue'>): GuardContext => ({
    ...base,
    from: input.row.status,
    to: input.to,
    executor: input.tx,
  });
  const guards: Record<IssueGuard, Guard<'issue'>> = {
    admit: async () => {
      const denied = permissionRefusal(
        base.facts.permissions,
        ISSUE_ADMIT_PERMISSION,
        'promoting a `draft` to `open`',
      );
      return denied ? ({ ...denied, path: '/status' } as Refusal) : null;
    },
    holder: async (input) => {
      const ctx = ctxOf(input);
      return refusalOf((await heldTakeGuard(ctx)) ?? (await holderGuard(ctx)));
    },
    plan_checkpoint: async (input) => refusalOf(await planGuard(ctxOf(input))),
    merged: async (input) => {
      const missing = await mergeNotRecorded(input.tx, { issueId: input.row.id, to: input.to });
      return missing
        ? ({
            code: missing.code,
            path: '/status',
            detail: missing.detail,
            details: missing.details,
          } as Refusal)
        : null;
    },
    released: async (input) => refusalOf(await releaseGuard(ctxOf(input))),
    verdicts: async (input) => {
      const ctx = ctxOf(input);
      return refusalOf((await planDriftGuard(ctx)) ?? (await verdictGuard(ctx)));
    },
    // A park returning to the status it left is the park's own edge, not an entry: the status was
    // earned when it was first entered. A park with no recorded left status going anywhere is an
    // entry like any other, and owes that entry's guards.
    left_status: async (input) => {
      const left = base.leftStatus ?? null;
      if (left === input.to) return null;
      if (left !== null) {
        return refusalOf(edgeFault({ from: input.row.status, to: input.to, leftStatus: left }));
      }
      for (const name of entryGuardsOf(input.to)) {
        const refused = await guards[name as IssueGuard](input);
        if (refused) return refused;
      }
      return null;
    },
    unheld: async (input) => {
      const holder = await issueHolder(
        input.tx,
        base.issue,
        new Date(),
        base.recoveringRunId ?? null,
      );
      if (!holder) return null;
      return refusalOf({
        code: 'ILLEGAL_TRANSITION',
        detail: `a recovery move hands back an \`in_progress\` issue nothing holds, and ${holder} holds this one — it stays with its holder`,
        details: { from: input.row.status, to: input.to, holder },
      });
    },
  };
  return guards;
}

function sqlPlanRow(issueId: string) {
  return sql`SELECT plan, acceptance_criteria FROM issues WHERE id = ${issueId}`;
}
