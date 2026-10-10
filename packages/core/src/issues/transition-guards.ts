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
 *   approved           plan and criteria written; the actor holds `plans.approve`  PLAN_REQUIRED
 *                      where the project document sets `plan.approval.required`
 *                      the design passes the design check (`design-record.ts`)  DESIGN_RECORD_MISSING,
 *                                                                               DESIGN_RECORD_INCOMPLETE
 *   awaiting_release   the run holding it makes the move, or a holder of          NOT_THE_HOLDER
 *                      `releases.approve` or `project.admin` does
 *                      the merge is recorded (a landing moves no status)          MERGE_NOT_RECORDED
 *                      no new pattern waits on its reviewer, and no returned      PATTERN_REVIEW_PENDING,
 *                      one stands unanswered; each approved new pattern's         PATTERN_RETURNED,
 *                      catalog page is in the change the merge mark names        PATTERN_ENTRY_MISSING
 *                      (`pattern-entry.ts`, read before the lock). No verdict is asked: verdicts are
 *                      judged on the release that carries the work (REQ-45 BC-2)
 *   closed             from awaiting_release, by a release that claimed it        CLOSE_ONLY_BY_RELEASE
 *                      (a release batch or a recorded release), merge recorded   CLOSE_REQUIRES_SHIPPED
 *                      from any other live status, or from awaiting_release      DESIGN_NOT_DELIVERED
 *                      without a release, only a design-only issue whose design
 *                      revisions are all approved (REQ-45 BC-4)
 *
 *   needs_info         a question (the reason) and its kind                      TRANSITION_REASON_REQUIRED,
 *                                                                                WAITING_KIND_REQUIRED
 *   on_hold, reopen    a reason                                                  TRANSITION_REASON_REQUIRED
 *   dropped            a reason                                                  VOID_REASON_REQUIRED
 */

import { CHECKLIST_GUARD } from '@forge/contracts/checklists';
import type { IssueTransitionRefusalCode } from '@forge/contracts/issue-machine';
import { ISSUE_MACHINE, type IssueGuard, PARK_STATUSES } from '@forge/contracts/issue-machine';
import type { ActorAgency, ProjectPermission } from '@forge/contracts/permissions';
import { personGateAct, personGatePermission } from '@forge/contracts/person-gates';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
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
import { refuseHeldTake } from './blocked-by.js';
import { designHeldSql, designHoldsOf, designOnlyMarkSql } from './design-delivery.js';
import { designCheckOf } from './design-record.js';
import { mergeNotRecorded } from './merged-at.js';
import { type MoveEntryFacts, moveEntryRefusal, readMoveEntryFacts } from './pattern-entry.js';
import type { CatalogReading } from './pattern-rules.js';
import { catalogOf, patternReleaseRefusal } from './patterns.js';
import { readProjectDocument } from './ports.js';
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
  /** The project document sets `plan.approval.required`. */
  planApprovalRequired: boolean;
  /** Who admits a draft to open: the permission the project's `approvals.admit` names, and the act its refusal says. */
  admit: { permission: ProjectPermission; act: string };
  /** The mover's role and grants on the project. */
  permissions: PermissionFacts;
  /** Who is asking, as the run lane names a holder: the box the device or its token belongs to. */
  callerDeviceId: string | null;
  /** The permission that lets the mover make a move another run's hold reserves, or null. */
  holdOverride: HoldOverride | null;
  /** The move to awaiting_release: the issue's approved new patterns and the change its mark names. */
  patternEntry: MoveEntryFacts | null;
  /** The move to approved: the pattern catalog the project reads, which the design check asks. */
  catalog: CatalogReading | null;
}

const HOLD_OVERRIDES = ['releases.approve', 'project.admin'] as const;
type HoldOverride = (typeof HOLD_OVERRIDES)[number];

/** Only the move into `awaiting_release` asks who holds the issue. */
const ASKS_FOR_HOLDER: readonly IssueStatus[] = ['awaiting_release'];

async function callerDeviceOf(
  actorUserId: string,
  deviceId: string | null,
): Promise<string | null> {
  if (deviceId) return deviceId;
  const tokenId = actorFor(actorUserId).tokenId;
  if (!tokenId) return null;
  const rows = (await db.execute(
    sql`SELECT device_id FROM personal_access_tokens WHERE id = ${tokenId}`,
  )) as unknown as Array<{ device_id: string | null }>;
  return rows[0]?.device_id ?? null;
}

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
  to: IssueStatus;
}): Promise<IssueMoveFacts> {
  const { issue } = args;
  const document = (await readProjectDocument(issue.projectId))?.document;
  const asksForHolder = ASKS_FOR_HOLDER.includes(args.to);
  return {
    callerDeviceId: asksForHolder
      ? await callerDeviceOf(args.actorUserId, args.actorDeviceId ?? null)
      : null,
    holdOverride: asksForHolder ? await holdOverrideOf(args.actorUserId, issue.projectId) : null,
    planApprovalRequired: document?.plan?.approval.required === true,
    admit: {
      permission: personGatePermission(document?.approvals, 'admit'),
      act: personGateAct(document?.approvals, 'admit'),
    },
    permissions: await permissionFactsOf(args.actorUserId, issue.projectId),
    patternEntry: args.to === 'awaiting_release' ? await readMoveEntryFacts(issue) : null,
    catalog: args.to === 'approved' ? await catalogOf(issue.projectId) : null,
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

/**
 * awaiting_release is the holding run's own move (issue-lifecycle `awaiting_release`): the box
 * whose run session leases the issue makes it, or someone holding `releases.approve` or
 * `project.admin` does on purpose. Anyone else is refused, the holder named.
 */
async function runHolderGuard(ctx: GuardContext): Promise<GuardFault | null> {
  if (ctx.facts.holdOverride) return null;
  const rows = (await ctx.executor.execute(sql`
    SELECT l.device_id, l.session_id, l.run_id
      FROM issue_leases l
      JOIN issues i ON i.project_id = l.project_id AND l.issue_key = 'ISS-' || i.iss_seq
     WHERE i.id = ${ctx.issue.id}
  `)) as unknown as Array<{ device_id: string; session_id: string; run_id: string }>;
  const lease = rows[0];
  const caller = ctx.facts.callerDeviceId;
  if (lease && caller !== null && lease.device_id === caller) return null;
  const held = lease
    ? `run session ${lease.session_id} on device ${lease.device_id} holds it`
    : 'no run session holds it';
  const asking =
    caller === null
      ? 'the caller is not a paired box or its token'
      : `the caller is device ${caller}`;
  return {
    code: 'NOT_THE_HOLDER',
    detail: `\`awaiting_release\` is the move of the run holding the issue, and ${held} while ${asking}. Make the move from the holding run, or as someone holding ${HOLD_OVERRIDES.map(quote).join(' or ')} on the project.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      holder: lease
        ? { deviceId: lease.device_id, sessionId: lease.session_id, runId: lease.run_id }
        : null,
      callerDeviceId: caller,
      permissions: HOLD_OVERRIDES,
    },
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

/**
 * approved, after the design step (Issue lifecycle r15): what the checkpoint approves is a design
 * that passed the design check, and a claim from approved resumes at build. A recovery edge back to
 * approved does not name this guard: a run ending hands the issue back whatever it recorded.
 */
async function designGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const check = await designCheckOf(ctx.executor, ctx.issue, ctx.facts.catalog ?? undefined);
  if (check.passed) return null;
  return {
    code: check.code,
    detail: check.detail,
    details: { from: ctx.from, to: ctx.to, missing: check.missing, gaps: check.gaps },
  };
}

/**
 * closed from awaiting_release: a release closes what it claimed (`issues.release_batch_run_id`); a
 * design-only issue needs none, its approved revisions being what shipped (REQ-45 BC-4).
 */
async function releaseGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const rows = (await ctx.executor.execute(
    sql`SELECT release_batch_run_id FROM issues WHERE id = ${ctx.issue.id}`,
  )) as unknown as Array<{ release_batch_run_id: string | null }>;
  if (rows[0]?.release_batch_run_id) return null;
  const design = await readDesignDelivery(ctx);
  if (design.designOnly && design.unapproved.length === 0 && design.approved.length > 0)
    return null;
  return {
    code: 'CLOSE_ONLY_BY_RELEASE',
    detail: `an issue that ships code closes through a release, and no release has claimed this one${design.designOnly ? `; it is design-only, and ${designShortfall(design)}` : ''}. Finish a release batch carrying it (\`POST /api/projects/${ctx.issue.projectId}/release-batches\`), or record the release that already happened (\`POST /api/projects/${ctx.issue.projectId}/release-records\`); either closes every issue it carries.`,
    details: { from: ctx.from, to: ctx.to, designOnly: design.designOnly },
  };
}

interface DesignDelivery {
  /** The merge mark names design artifacts and nothing else: no commit, no paths. */
  designOnly: boolean;
  /** The design revisions the mark names. */
  marked: string[];
  /** `<flow> rev <n>` of every revision this issue drew that was approved. */
  approved: string[];
  /** `<flow> rev <n>` of every revision it delivers that is not approved yet. */
  unapproved: string[];
}

async function readDesignDelivery(ctx: GuardContext): Promise<DesignDelivery> {
  const rows = (await ctx.executor.execute(sql`
    SELECT ${designOnlyMarkSql(sql`i`)} AS design_only,
           coalesce((SELECT array_agg(a->>'ref') FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(i.merged_artifacts) = 'array' THEN i.merged_artifacts ELSE '[]'::jsonb END) a),
                    '{}') AS marked,
           coalesce((SELECT array_agg(DISTINCT w.flow || ' rev ' || d.revision)
                       FROM project_workflow_designs d JOIN project_workflows w ON w.id = d.workflow_id
                      WHERE d.design_issue_id = i.id AND d.decision = 'approve'), '{}') AS approved,
           ${designHeldSql(sql`i.id`)} AS held
      FROM issues i WHERE i.id = ${ctx.issue.id}
  `)) as unknown as Array<{
    design_only: boolean;
    marked: string[];
    approved: string[];
    held: boolean;
  }>;
  const row = rows[0];
  if (!row) return { designOnly: false, marked: [], approved: [], unapproved: [] };
  const unapproved = row.held
    ? ((await designHoldsOf(ctx.executor, [ctx.issue.id])).get(ctx.issue.id) ?? []).map(
        (h) => `${h.flow} rev ${h.revision}`,
      )
    : [];
  return {
    designOnly: row.design_only === true,
    marked: row.marked,
    approved: row.approved,
    unapproved,
  };
}

function designShortfall(d: DesignDelivery): string {
  if (d.unapproved.length > 0) return `design ${d.unapproved.join(', ')} is not approved yet`;
  return 'no design revision it drew is approved';
}

/** closed from a live status: the issue is design-only and every revision it delivers is approved. */
async function designDeliveredGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const d = await readDesignDelivery(ctx);
  if (d.designOnly && d.unapproved.length === 0 && d.approved.length > 0) return null;
  const why = d.designOnly
    ? designShortfall(d)
    : 'its merge mark does not name design revisions alone (a commit, read paths, or a non-design artifact is on it, or there is no mark), so its work ships through a release';
  return {
    code: 'DESIGN_NOT_DELIVERED',
    detail: `${quote(ctx.from)} → \`closed\` is the close of an issue whose only deliverable is a design, once its design revisions are approved, and ${why}. An issue that ships code moves to \`awaiting_release\` and closes through its release.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      designOnly: d.designOnly,
      marked: d.marked,
      approved: d.approved,
      unapproved: d.unapproved,
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
        : ((await patternReleaseRefusal(input.tx, input.row.id)) ??
            (await patternEntryGuard(input.tx, input.row.id, base.facts.patternEntry)));
    },
    released: async (input) => refusalOf(await releaseGuard(ctxOf(input))),
    design_delivered: async (input) => refusalOf(await designDeliveredGuard(ctxOf(input))),
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

function sqlPlanRow(issueId: string) {
  return sql`SELECT plan, acceptance_criteria FROM issues WHERE id = ${issueId}`;
}
