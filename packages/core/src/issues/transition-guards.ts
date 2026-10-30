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
 *   open, from draft   the actor holds what `approvals.admit` asks: `issues.admit` PERMISSION_FORBIDDEN
 *                      where it is on, `project.write` where it is off; the
 *                      issue-ready checklist the kernel judges                  CHECKLIST_INCOMPLETE
 *   in_progress        a run or lease holds it; nothing admissible holds out     NO_HOLDER, ISSUE_BLOCKED, WORKFLOW_DESIGN_NOT_APPROVED,
 *                                                                               CONTRACT_WAIT_UNSETTLED
 *                      where a run holds it, that run makes the move, or a       NOT_THE_HOLDER
 *                      holder of `releases.approve` or `project.admin` does
 *   approved           plan and criteria written (what the status says)          PLAN_REQUIRED
 *                      the actor holds `plans.approve` where gate                PERMISSION_FORBIDDEN
 *                      `plan_approval` is enforced (REQ-76: strict, or
 *                      standard's `plan.approval.required`; never yolo)
 *                      the design passes the design check (`design-record.ts`)  DESIGN_RECORD_MISSING,
 *                      where gate `design_record` is enforced                  DESIGN_RECORD_INCOMPLETE
 *
 *   Each policy guard here asks its gate as the project's gate profile resolves it (REQ-76,
 *   `@forge/contracts/gate-profiles`), read before the lock with the project document, and a
 *   refusal ends naming the gate, the profile and the key that relaxes it. Holding, the recorded
 *   merge, the release close and the edge itself are the kernel: no profile relaxes them (BC-10).
 *   awaiting_release   the run holding it makes the move, or a holder of          NOT_THE_HOLDER
 *                      `releases.approve` or `project.admin` does
 *                      the merge is recorded (a landing moves no status)          MERGE_NOT_RECORDED
 *                      no new pattern waits on its reviewer, and no returned      PATTERN_REVIEW_PENDING,
 *                      one stands unanswered; each approved new pattern's         PATTERN_RETURNED,
 *                      catalog page is in the change the merge mark names        PATTERN_ENTRY_MISSING
 *                      (`pattern-entry.ts`, read before the lock). No verdict is asked: verdicts are
 *                      judged on the release that carries the work (REQ-45 BC-2)
 *   closed             from awaiting_release, by a release that claimed it        CLOSE_ONLY_BY_RELEASE
 *                      (a release batch, a recorded release, or with no          CLOSE_REQUIRES_SHIPPED
 *                      production environment a recorded landing), merge recorded
 *                      from any other live status, or from awaiting_release      DESIGN_NOT_DELIVERED
 *                      without a release, only a design-only issue whose design
 *                      revisions are all approved (REQ-45 BC-4)
 *
 *   needs_info         a question (the reason) and its kind                      TRANSITION_REASON_REQUIRED,
 *                                                                                WAITING_KIND_REQUIRED
 *   on_hold, reopen    a reason                                                  TRANSITION_REASON_REQUIRED
 *   reopen, from       no running release batch claims it, but the claiming      ISSUE_REOPEN_RELEASING
 *   awaiting_release   release's own probe replay (`release-claim-guard.ts`)
 *   awaiting_release,  back the way it came: a requirement-level fail reopened  REOPEN_NOT_BY_REQUIREMENT_FAIL,
 *   closed, from       it from this status and is routed past it now            ILLEGAL_TRANSITION,
 *   reopen             (`fail-return.ts`, ISS-760); to closed, a design-only     REOPEN_CRITERIA_NOT_PASSING,
 *                      issue's delivered design closes it too                   REOPEN_FAIL_UNOWNED
 *   dropped            a reason                                                  VOID_REASON_REQUIRED
 */

import { CHECKLIST_GUARD } from '@forge/contracts/checklists';
import { gateSays, projectGates, type ResolvedGate } from '@forge/contracts/gate-profiles';
import type { IssueTransitionRefusalCode } from '@forge/contracts/issue-machine';
import { ISSUE_MACHINE, type IssueGuard, PARK_STATUSES } from '@forge/contracts/issue-machine';
import type { ActorAgency, ProjectPermission } from '@forge/contracts/permissions';
import {
  effectiveApprovals,
  personGateAct,
  personGatePermission,
} from '@forge/contracts/person-gates';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { gateRefusal } from '../lib/gated.js';
import type { Refusal } from '../lib/refusal.js';
import { isRefusal } from '../lib/refusal.js';
import type { Guard, GuardInput } from '../lifecycle/index.js';
import {
  actorFor,
  can,
  type PermissionFacts,
  permissionFactsOf,
  permissionRefusal,
  projectResource,
} from '../permissions/index.js';
import { readAdoptionDelivery } from './adoption-delivery.js';
import { refuseHeldTake } from './blocked-by.js';
import { type CallerBox, callerBoxOf } from './caller-box.js';
import {
  designDeliveredGuard,
  designShortfall,
  readDesignDelivery,
} from './design-delivered-guard.js';
import { designCheckOf } from './design-record.js';
import {
  asksFailReturn,
  type FailReturnFacts,
  failReturnFault,
  failReturnNote,
  readFailReturn,
} from './fail-return.js';
import type { IssueGates } from './gates.js';
import { mergeNotRecorded } from './merged-at.js';
import { type MoveEntryFacts, moveEntryRefusal, readMoveEntryFacts } from './pattern-entry.js';
import type { CatalogReading } from './pattern-rules.js';
import { catalogOf, patternReleaseRefusal } from './patterns.js';
import { readProjectDocument } from './ports.js';
import { releaseClaimRefusal } from './release-claim-guard.js';
import {
  callerHolds,
  holderSentence,
  holderShown,
  type RunHolder,
  runHoldersOf,
} from './run-holder.js';
import { isBlankPlan } from './transition-evidence.js';
import { edgeFault, quote } from './transition-faults.js';
import { issueHolder } from './work-state.js';

export type GuardCode = Exclude<
  IssueTransitionRefusalCode,
  | 'NO_OP'
  | 'STALE_TRANSITION'
  | 'WAITING_KIND_NOT_APPLICABLE'
  | 'NEEDS_NOT_APPLICABLE'
  | 'ISSUE_ARCHIVED'
  | 'OPEN_QUESTIONS'
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
}

/** What the guards read from outside the issue's rows, read before the move takes its lock. */
interface IssueMoveFacts {
  /** Every gate's mode on the project, as its gate profile resolves them (REQ-76). */
  gates: IssueGates;
  /** Who admits a draft to open: the permission the project's `approvals.admit` names, and the act its refusal says. */
  admit: { permission: ProjectPermission; act: string };
  /** The mover's role and grants on the project. */
  permissions: PermissionFacts;
  /** Who is asking, as the run lane names a holder: the box the device or its token belongs to, and the token. */
  caller: CallerBox | null;
  /** The permission that lets the mover make a move another run's hold reserves, or null. */
  holdOverride: HoldOverride | null;
  /** The move to awaiting_release: the issue's approved new patterns and the change its mark names. */
  patternEntry: MoveEntryFacts | null;
  /** The move to approved: the pattern catalog the project reads, which the design check asks. */
  catalog: CatalogReading | null;
  /** The way back from `reopen` to a landed status: the reopen it would undo (ISS-760). */
  failReturn: FailReturnFacts | null;
}

const HOLD_OVERRIDES = ['releases.approve', 'project.admin'] as const;
type HoldOverride = (typeof HOLD_OVERRIDES)[number];

/** The moves that ask who holds the issue: the claim, and the holding run's move to its release. */
const ASKS_FOR_HOLDER: readonly IssueStatus[] = ['in_progress', 'awaiting_release'];

async function holdOverrideOf(
  actorUserId: string,
  projectId: string,
): Promise<HoldOverride | null> {
  const actor = actorFor(actorUserId);
  for (const permission of HOLD_OVERRIDES) {
    if (await can(actor, permission, projectResource(projectId))) return permission;
  }
  return null;
}

export async function readIssueMoveFacts(args: {
  issue: { id: string; projectId: string };
  actorUserId: string;
  /** The box making the move, where the actor is the device itself. */
  actorDeviceId?: string | null;
  from: IssueStatus;
  to: IssueStatus;
}): Promise<IssueMoveFacts> {
  const { issue } = args;
  const document = (await readProjectDocument(issue.projectId))?.document;
  const asksForHolder = ASKS_FOR_HOLDER.includes(args.to);
  return {
    caller: asksForHolder ? await callerBoxOf(args.actorUserId, args.actorDeviceId ?? null) : null,
    holdOverride: asksForHolder ? await holdOverrideOf(args.actorUserId, issue.projectId) : null,
    gates: Object.fromEntries(projectGates(document, null).map((g) => [g.id, g])) as IssueGates,
    admit: {
      permission: personGatePermission(effectiveApprovals(document), 'admit'),
      act: personGateAct(document, 'admit'),
    },
    permissions: await permissionFactsOf(args.actorUserId, issue.projectId),
    patternEntry: args.to === 'awaiting_release' ? await readMoveEntryFacts(issue) : null,
    catalog: args.to === 'approved' ? await catalogOf(issue.projectId) : null,
    failReturn: asksFailReturn(args.from, args.to) ? await readFailReturn(db, issue) : null,
  };
}

/**
 * Each approved new pattern's page is in the change the merge mark names. Asked only where the facts
 * were read for this move (awaiting_release); `closed` follows awaiting_release, which asked it.
 */
async function patternEntryGuard(
  tx: Pick<Tx, 'select' | 'execute'>,
  issueId: string,
  facts: MoveEntryFacts | null,
): Promise<Refusal | null> {
  if (!facts) return null;
  return moveEntryRefusal(tx, issueId, facts);
}

// a person's move is refused as an agent's: issue-lifecycle rev 3 puts the condition on the edge, not the actor (ISS-104 decision)
async function heldTakeGuard(ctx: GuardContext): Promise<GuardFault | null> {
  try {
    await refuseHeldTake(ctx.executor, ctx.issue.id, 'a move to `in_progress`', ctx.facts.gates);
    return null;
  } catch (err) {
    if (isRefusal(err, 'ISSUE_BLOCKED')) {
      return {
        code: 'ISSUE_BLOCKED',
        detail: err.refusals.map((r) => r.detail).join(' '),
        details: { from: ctx.from, to: ctx.to },
      };
    }
    if (isRefusal(err, 'WORKFLOW_DESIGN_NOT_APPROVED')) {
      const [gate] = err.refusals as readonly (Refusal & { blocked?: unknown })[];
      return {
        code: 'WORKFLOW_DESIGN_NOT_APPROVED',
        detail: gate?.detail ?? '',
        details: { from: ctx.from, to: ctx.to, blocked: gate?.blocked },
      };
    }
    throw err;
  }
}

/**
 * How an issue nobody holds is claimed, moved and handed back, named on every refusal that finds no
 * holder: the lease a master's claim writes on the work state (`run-holder.ts`), from the caller's
 * own box or token, and the same lease written again with one minute to let it go.
 */
const claimDoor = (issueId: string) =>
  `claim it first: write its lease (PATCH /api/issues/${issueId} with the \`sessionContext\` you read, its \`lease\` set to { holder, renewedAt, minutes }), make the move, then hand it back by writing that lease again with minutes 1`;

/**
 * in_progress, entered by a claim: a run or a lease holds the issue, and where a run holds it, the
 * caller is that run (ISS-589 r2) — the same reading and refusal as awaiting_release. A job or
 * pipeline run over it, with no run holding it, holds it as before.
 */
async function holderGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const holders = await runHoldersOf(ctx.executor, ctx.issue);
  if (holders.length > 0) return notTheHolder(ctx, holders);
  const holder = await issueHolder(ctx.executor, ctx.issue);
  if (holder) return null;
  return {
    code: 'NO_HOLDER',
    detail: `\`in_progress\` says a run is working this issue, and nothing holds it: no live lease on its work state, no live run session over it, and no job or run over it. To take it, ${claimDoor(ctx.issue.id)}, or declare a run session over it; an issue nobody holds stays at ${quote(ctx.from)} where a master can take it.`,
    details: { from: ctx.from, to: ctx.to },
  };
}

/**
 * awaiting_release is the holding run's own move (issue-lifecycle `awaiting_release`): the box of a
 * run holding the issue makes it — a run session's or a declared run's (`run-holder.ts`) — or someone
 * holding `releases.approve` or `project.admin` does on purpose. Anyone else is refused, every holder
 * named.
 */
async function runHolderGuard(ctx: GuardContext): Promise<GuardFault | null> {
  return notTheHolder(ctx, await runHoldersOf(ctx.executor, ctx.issue));
}

/**
 * The move is the holding run's: null where the caller is one of `holders` (`run-holder.ts:
 * callerHolds`) or holds a hold override, else NOT_THE_HOLDER naming every holder and the caller.
 */
function notTheHolder(ctx: GuardContext, holders: readonly RunHolder[]): GuardFault | null {
  if (ctx.facts.holdOverride) return null;
  const caller = ctx.facts.caller;
  if (callerHolds(holders, caller)) return null;
  const held =
    holders.length > 0
      ? `${holders.map(holderSentence).join(' and ')} holds it`
      : 'no run holds it';
  const asking = caller?.deviceId
    ? `the caller is device ${caller.deviceId}`
    : caller?.tokenId
      ? 'the caller is a token bound to no box that wrote no lease held here'
      : 'the caller is not a paired box or its token';
  const session = holders.find((h) => h.kind === 'run-session');
  const from =
    holders.length > 0
      ? 'Make the move from the holding run'
      : `Nobody holds it, so ${claimDoor(ctx.issue.id)}`;
  return {
    code: 'NOT_THE_HOLDER',
    detail: `${quote(ctx.to)} is the move of the run holding the issue, and ${held} while ${asking}. ${from}; or make it as someone holding ${HOLD_OVERRIDES.map(quote).join(' or ')} on the project.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      holder: session
        ? { deviceId: session.deviceId, sessionId: session.sessionId, runId: session.runId }
        : null,
      holders: holders.map(holderShown),
      callerDeviceId: caller?.deviceId ?? null,
      permissions: HOLD_OVERRIDES,
    },
  };
}

/** approved, the plan checkpoint: a plan and criteria, and plans.approve where the project says so. */
async function planGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const gate = ctx.facts.gates.plan_approval;
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
  if (gate.mode === 'enforce') {
    const denied = permissionRefusal(
      ctx.facts.permissions,
      'plans.approve',
      'moving an issue to `approved`',
    );
    if (denied) {
      return {
        code: denied.code,
        detail: `${denied.detail} Ask for it: park at \`needs_info\` with \`waitingKind: "needs_decision"\` naming the plan, and a holder of ${denied.permission} moves it once it is back. ${gateSays(gate)}`,
        details: {
          from: ctx.from,
          to: ctx.to,
          permission: denied.permission,
          scope: denied.scope,
          rule: gate.key,
          gate: gate.id,
          profile: gate.profile,
        },
      };
    }
  }
  return null;
}

/**
 * approved, after the design step (Issue lifecycle r15): what the checkpoint approves is a design
 * that passed the design check, and a claim from approved resumes at build. A recovery edge back to
 * approved does not name this guard: a run ending hands the issue back whatever it recorded.
 */
async function designGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const gate = ctx.facts.gates.design_record;
  if (gate.mode !== 'enforce') return null;
  const check = await designCheckOf(ctx.executor, ctx.issue, ctx.facts.catalog ?? undefined);
  if (check.passed) return null;
  return {
    code: check.code,
    detail: `${check.detail} ${gateSays(gate)}`,
    details: { from: ctx.from, to: ctx.to, missing: check.missing, gaps: check.gaps },
  };
}

/**
 * closed from awaiting_release: a release closes what it claimed (`issues.release_batch_run_id`); a
 * design-only issue needs none, its approved revisions being what shipped (REQ-45 BC-4), and neither
 * does an adoption-only one while its record holds (REQ-5 BC-17).
 */
async function releaseGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const rows = (await ctx.executor.execute(
    sql`SELECT release_batch_run_id FROM issues WHERE id = ${ctx.issue.id}`,
  )) as unknown as Array<{ release_batch_run_id: string | null }>;
  if (rows[0]?.release_batch_run_id) return null;
  // an adoption-only issue ships nothing either: the record it adopted is what landed (REQ-5 BC-17)
  const adoption = await readAdoptionDelivery(ctx.executor, ctx.issue.id);
  if (adoption.refs && !adoption.shortfall) return null;
  const design = await readDesignDelivery(ctx);
  if (design.designOnly && design.unapproved.length === 0 && design.approved.length > 0)
    return null;
  return {
    code: 'CLOSE_ONLY_BY_RELEASE',
    detail: `an issue that ships code closes through a release, and no release has claimed this one${design.designOnly ? `; it is design-only, and ${designShortfall(design)}` : ''}${adoption.shortfall ? `; its mark is an adoption record that no longer holds: ${adoption.shortfall}` : ''}. Finish a release batch carrying it (\`POST /api/projects/${ctx.issue.projectId}/release-batches\`), or record the release that already happened (\`POST /api/projects/${ctx.issue.projectId}/release-records\`), which on a project with no production environment records its landing; either closes every issue it carries.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      designOnly: design.designOnly,
      adopted: adoption.refs,
    },
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
  /** The release whose own probe replay sends a member back (`apply-transition.ts:reopenAsItsRelease`). */
  releaseReplayRunId?: string | null | undefined;
  /** Where the `fail_routed` guard leaves the note its move posts, once it lets the move go back. */
  failReturned?: { note: string | null } | undefined;
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
        base.facts.admit.permission,
        base.facts.admit.act,
      );
      return denied ? ({ ...denied, path: '/status' } as Refusal) : null;
    },
    holder: async (input) => {
      const ctx = ctxOf(input);
      return refusalOf((await heldTakeGuard(ctx)) ?? (await holderGuard(ctx)));
    },
    plan_checkpoint: async (input) => refusalOf(await planGuard(ctxOf(input))),
    design: async (input) => refusalOf(await designGuard(ctxOf(input))),
    run_holder: async (input) => refusalOf(await runHolderGuard(ctxOf(input))),
    merged: async (input) => {
      const missing = await mergeNotRecorded(input.tx, { issueId: input.row.id, to: input.to });
      return missing
        ? ({
            code: missing.code,
            path: '/status',
            detail: missing.detail,
            details: missing.details,
          } as Refusal)
        : await patternsUnderGate(
            base.facts.gates.patterns,
            async () =>
              (await patternReleaseRefusal(input.tx, input.row.id)) ??
              (await patternEntryGuard(input.tx, input.row.id, base.facts.patternEntry)),
          );
    },
    released: async (input) => refusalOf(await releaseGuard(ctxOf(input))),
    design_delivered: async (input) => refusalOf(await designDeliveredGuard(ctxOf(input))),
    not_releasing: (input) =>
      releaseClaimRefusal(input.tx, input.row.id, base.releaseReplayRunId ?? null),
    // back the way a requirement-level fail's reopen came (ISS-760); the edge to `closed` is also a
    // design-only issue's close from `reopen`, answered as from any other live status
    fail_routed: async (input) => {
      const ctx = ctxOf(input);
      if (input.to === 'closed' && (await readDesignDelivery(ctx)).designOnly) {
        return refusalOf(await designDeliveredGuard(ctx));
      }
      const facts = base.facts.failReturn;
      const fault = facts
        ? failReturnFault(facts, { from: input.row.status, to: input.to })
        : {
            code: 'REOPEN_NOT_BY_REQUIREMENT_FAIL' as const,
            detail: `the move back from \`reopen\` was not read for this move to ${quote(input.to)}`,
            details: { from: input.row.status, to: input.to },
          };
      if (!fault && facts && base.failReturned) {
        base.failReturned.note = failReturnNote(facts, input.to);
      }
      return refusalOf(fault);
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
        if (name === CHECKLIST_GUARD) {
          // the entry asks a checklist, which only its own edge runs: a park with no recorded left
          // status cannot enter it on the park's edge
          return refusalOf({
            code: 'ILLEGAL_TRANSITION',
            detail: `this park recorded no status it left, and ${quote(input.to)} is entered only through the edge that asks its checklist. Move it to a status the park can return to, or drop it.`,
            details: { from: input.row.status, to: input.to, leftStatus: null },
          });
        }
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

/** The pattern checks of the merged guard, asked only where gate `patterns` is enforced, said as it. */
async function patternsUnderGate(
  gate: ResolvedGate,
  check: () => Promise<Refusal | null>,
): Promise<Refusal | null> {
  if (gate.mode !== 'enforce') return null;
  const refused = await check();
  return refused ? gateRefusal(gate, refused) : null;
}

function sqlPlanRow(issueId: string) {
  return sql`SELECT plan, acceptance_criteria FROM issues WHERE id = ${issueId}`;
}
