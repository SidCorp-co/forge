/**
 * Verdicts recorded on a requirement's business criteria at the requirement itself (ISS-588, REQ-74
 * BC-4, BC-5): how a capability that already shipped is proven on the running build without an issue
 * whose only work is verifying it (REQ-45 r3 BC-8). The write is refused by name
 * (`verdict-rules.ts`); each row is read into the criterion's coverage (`standing-coverage.ts`), so
 * it reads with the requirement's standing, and listed on its own.
 */

import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import {
  type RecordRequirementVerdictRequest,
  type RequirementCoverage,
  type RequirementVerdictRow,
  requirementKey,
} from '@forge/contracts/requirements';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { requirementCriterionVerdicts } from '../db/schema-requirement-verdicts.js';
import { requirementCriteria } from '../db/schema-requirements.js';
import { issueDisplayIds, requirementRecordingSessionOf } from '../issues/index.js';
import { peopleOf } from '../lib/people.js';
import { emitEvents } from '../outbox/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type RequirementActor, rowIn } from './read.js';
import { liveAt, type RequirementRefusal } from './rules.js';
import { requirementVerdictsOf } from './standing-facts.js';
import { standingsOf } from './standing-read.js';
import { requirementVerdictRefusals } from './verdict-rules.js';

/**
 * What a fail recorded at the requirement did to one issue tracing its criterion (ISS-756): sent back
 * to `reopen`, left building as the owner of what is missing, or left standing because its own half
 * is delivered. `why` is said on the issue too, where it is not sent back.
 */
export interface FailRouted {
  issueId: string;
  key: string;
  status: string;
  outcome: 'reopen' | 'building' | 'stays';
  why: string;
}

export type RecordedVerdict =
  | { ok: true; verdictId: string; coverage: RequirementCoverage; routed: FailRouted[] }
  | { ok: false; refusals: RequirementRefusal[] };

export interface Tracing {
  id: string;
  status: string;
}

/**
 * Every issue but a dropped one whose criteria trace `code` of the requirement, on any wording, newest
 * landing first: landed (`awaiting_release`, `closed`) before not, then by merge, then by number.
 * `as` reads one issue at another status, where the way back from a reopen asks how the fail would
 * route it once back (ISS-760).
 */
export async function tracingIssuesOf(
  tx: Pick<Tx, 'execute'>,
  requirementId: string,
  code: string,
  as?: { issueId: string; status: string },
): Promise<Tracing[]> {
  const status = as
    ? sql`(CASE WHEN i.id = ${as.issueId}::uuid THEN ${as.status} ELSE i.status END)`
    : sql`i.status`;
  return (await tx.execute(sql`
    SELECT i.id, ${status} AS status
      FROM issues i
     WHERE i.status <> 'dropped'
       AND EXISTS (
         SELECT 1 FROM issue_criteria ic
           JOIN requirement_criteria rc ON rc.id = ic.requirement_criterion_id
          WHERE ic.issue_id = i.id AND ic.retired_at IS NULL
            AND rc.requirement_id = ${requirementId} AND rc.code = ${code})
     ORDER BY (${status} IN ('awaiting_release', 'closed')) DESC, i.merged_at DESC NULLS LAST,
              i.iss_seq DESC`)) as unknown as Tracing[];
}

/** Whether every criterion of `issueId` tracing the BC counts as a pass in its coverage: at its landing, on the current wording. */
export function deliversItsHalf(
  issueId: string,
  coverage: RequirementCoverage | undefined,
): boolean {
  const links = coverage?.issues.filter((l) => l.issueId === issueId) ?? [];
  return (
    links.length > 0 &&
    links.every((l) => !l.stale && l.verdict === 'pass' && l.notCounted === null)
  );
}

const LANDED: ReadonlySet<string> = new Set(ISSUE_RESOLVED_STATUSES);

const listed = (keys: readonly string[]) =>
  keys.length === 1 ? `${keys[0]} owns` : `${keys.join(', ')} own`;

/**
 * Where a fail on `bc` goes (REQ-45 BC-2, BC-10, BC-12; ISS-756). A landed issue whose own criteria
 * tracing it do not all pass is sent back to `reopen`: what failed is its. One still being built owns
 * what is missing and is left where it is. Where neither is there, the newest landing is sent back,
 * being the only one left to own it. Every other landed issue delivered its half and stays, told why:
 * reopening it would leave a correction it cannot make on an issue with no legal way back.
 */
export function routeFail(
  bc: string,
  tracing: readonly Tracing[],
  keys: ReadonlyMap<string, string>,
  coverage: RequirementCoverage | undefined,
): FailRouted[] {
  const keyOf = (id: string) => keys.get(id) ?? id;
  const landed = tracing.filter((i) => LANDED.has(i.status));
  const building = tracing.filter((i) => !LANDED.has(i.status));
  const failing = landed.filter((i) => !deliversItsHalf(i.id, coverage));
  const newest = landed[0];
  const reopened = failing.length > 0 || building.length > 0 || !newest ? failing : [newest];
  const sentBack = new Set(reopened.map((i) => i.id));
  const owners = [...reopened, ...building].map((i) => keyOf(i.id));
  return tracing.map((i) => {
    const route = { issueId: i.id, key: keyOf(i.id), status: i.status };
    if (sentBack.has(i.id)) {
      const why = failing.includes(i)
        ? `its criteria tracing ${bc} do not all pass at its landing`
        : `it is the newest landing tracing ${bc}, and no issue still being built does`;
      return { ...route, outcome: 'reopen', why };
    }
    if (!LANDED.has(i.status)) {
      return {
        ...route,
        outcome: 'building',
        why: `it is still being built and owns what ${bc} lacks`,
      };
    }
    return {
      ...route,
      outcome: 'stays',
      why: `its criteria tracing ${bc} all pass at its landing, and ${listed(owners)} what is missing`,
    };
  });
}

/**
 * Records one judgement of a business criterion on the running build, as its writer (project.write,
 * like a verdict on an issue criterion), and answers the criterion's coverage as the standing now
 * reads it, so the writer sees at once whether it counts.
 */
export async function recordRequirementVerdict(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  deviceId: string | null;
  body: RecordRequirementVerdictRequest;
}): Promise<RecordedVerdict> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const criteria = await db
    .select()
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, row.id));
  const judged = requirementVerdictRefusals({
    key: requirementKey(row.reqSeq),
    status: row.status,
    live: row.currentRevision === null ? [] : liveAt(criteria, row.currentRevision),
    body,
  });
  if ('refusals' in judged) return { ok: false, refusals: judged.refusals };
  const key = requirementKey(row.reqSeq);
  const bc = `${key} ${judged.criterion.code}`;
  // whether each tracing issue delivered its half is read before the fail is, off the coverage the
  // standing and the accept read (BC-12, BC-13: a pass at its landing counts as it does there)
  const before =
    body.verdict === 'fail'
      ? (await standingsOf(projectId, [row], null))
          .get(row.id)
          ?.coverage.find((c) => c.code === judged.criterion.code)
      : undefined;
  const recorded = await db.transaction(async (tx) => {
    // the run named is held by the issue door's rule, so one rule covers a verdict at either door
    const run = await requirementRecordingSessionOf(tx, {
      projectId,
      box: input.deviceId,
      run: body.run,
      judged: `${bc}'s verdict`,
    });
    if (!run.ok) return { ok: false as const, refusal: run.refusal };
    const [inserted] = await tx
      .insert(requirementCriterionVerdicts)
      .values({
        requirementId: row.id,
        requirementCriterionId: judged.criterion.id,
        verdict: body.verdict as RequirementVerdictRow['verdict'],
        reason: body.reason?.trim() || null,
        evidence: [...(body.evidence ?? [])],
        commitSha: body.verdict === 'skipped' ? null : (body.identity?.sha.toLowerCase() ?? null),
        authorUserId: actor.userId,
        authorDeviceId: input.deviceId,
        authorAgency: actor.agency,
        runSessionId: run.session,
      })
      .returning({ id: requirementCriterionVerdicts.id });
    if (!inserted) throw new Error(`requirements: the verdict on ${row.id} was not written`);
    if (body.verdict !== 'fail') return { ok: true as const, written: inserted, routed: [] };
    const tracing = await tracingIssuesOf(tx, row.id, judged.criterion.code);
    const keys = await issueDisplayIds(
      tracing.map((i) => i.id),
      tx,
    );
    const routes = routeFail(bc, tracing, keys, before);
    // the fail is corrected in the issue that owns what failed, never in a new one (REQ-74 BC-3,
    // REQ-45 BC-10); every other issue tracing it is told why it was not sent back
    await emitEvents(
      tx,
      routes.map((r) => ({
        type: 'verdict.recorded' as const,
        payload: {
          projectId,
          issueId: r.issueId,
          verdictId: inserted.id,
          commitSha: body.identity?.sha.toLowerCase() ?? null,
          failed: {
            criterion: null,
            requirement: bc,
            reason: body.reason?.trim() || null,
            authorUserId: actor.userId,
            authorDeviceId: input.deviceId,
            agency: actor.agency,
            stays: r.outcome === 'reopen' ? null : r.why,
          },
        },
      })),
    );
    return { ok: true as const, written: inserted, routed: routes };
  });
  if (!recorded.ok) return { ok: false, refusals: [recorded.refusal] };
  const { written, routed } = recorded;
  const standing = (await standingsOf(projectId, [row], null)).get(row.id);
  const coverage = standing?.coverage.find((c) => c.code === judged.criterion.code);
  if (!coverage) {
    throw new Error(
      `requirements: ${judged.criterion.code} of ${row.id} has no coverage after its verdict`,
    );
  }
  return { ok: true, verdictId: written.id, coverage, routed };
}

/** Every verdict recorded at the requirement, newest first, each naming the criterion it judged. */
export async function listRequirementVerdicts(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
}): Promise<RequirementVerdictRow[]> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const [verdicts, criteria] = await Promise.all([
    requirementVerdictsOf([row.id]),
    db
      .select({ id: requirementCriteria.id, code: requirementCriteria.code })
      .from(requirementCriteria)
      .where(eq(requirementCriteria.requirementId, row.id)),
  ]);
  const people = await peopleOf(verdicts.map((v) => v.authorUserId));
  const codes = new Map(criteria.map((c) => [c.id, c.code]));
  return verdicts.map((v) => ({
    id: v.id,
    criterion: codes.get(v.requirementCriterionId) ?? '',
    verdict: v.verdict,
    reason: v.note,
    evidence: [...v.evidence],
    commit: v.commit,
    run: v.runSession,
    by: v.authorUserId
      ? {
          id: v.authorUserId,
          name: people.get(v.authorUserId)?.name ?? null,
          agency: v.authorAgency,
        }
      : null,
    at: v.verdictAt.toISOString(),
  }));
}
