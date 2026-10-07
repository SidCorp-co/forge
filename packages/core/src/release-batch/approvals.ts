import type { ReleaseApprovalView } from '@forge/contracts/releases';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type ReleaseApprovalRow, releaseApprovals } from '../db/schema-release-ledger.js';
import { peopleOf } from '../lib/people.js';
import { agrees } from '../lib/plural.js';
import { RefusalError } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import { approvalRequired, environmentsOf, readReleasePath } from '../project-config/index.js';
import { refuseRelease } from './refuse.js';

// The issues kernel still reads the approval fact here; it is project-config's (`release-path.ts`).
export { approvalRequired };

const SHA = /^[0-9a-f]{40}$/;
const ENV_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export const approvalRequestSchema = z.strictObject({
  evidence: z.strictObject({
    environment: z.string().regex(ENV_NAME),
    commit: z.string().regex(SHA),
    reading: z.string().trim().min(1).max(500),
  }),
  note: z.string().trim().min(1).max(500).optional(),
});
type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

const DECISIONS = ['approve', 'return'] as const;

type Decision = { decision: 'approve' } | { decision: 'return'; reason: string };

// each wrong decision body is refused by what is wrong with it: an unknown verb and a return with no reason are different mistakes, and a schema's "Invalid input" names neither
export function parseDecision(raw: unknown): Decision {
  const body = (
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null
  ) as Record<string, unknown> | null;
  if (!body) {
    throw refuseRelease('RELEASE_DECISION_UNKNOWN', 'the body is { decision, reason? }', '');
  }
  const extra = Object.keys(body).filter((k) => k !== 'decision' && k !== 'reason');
  if (extra.length > 0) {
    throw refuseRelease(
      'RELEASE_APPROVAL_SHAPE',
      `unknown ${agrees(extra.length, 'key', 'keys')} ${extra.join(', ')}; a decision is { decision: "approve" } or { decision: "return", reason }`,
    );
  }
  if (body.decision !== 'approve' && body.decision !== 'return') {
    throw refuseRelease(
      'RELEASE_DECISION_UNKNOWN',
      `decision ${JSON.stringify(body.decision)} is not one of ${DECISIONS.join(' | ')}`,
    );
  }
  if (body.decision === 'approve') {
    if (body.reason !== undefined) {
      throw refuseRelease(
        'RELEASE_APPROVAL_SHAPE',
        'an approval carries no reason; a reason is what a return owes the master',
      );
    }
    return { decision: 'approve' };
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 1 || reason.length > 1000) {
    throw refuseRelease(
      'RELEASE_RETURN_WITHOUT_REASON',
      'a return says why, in 1 to 1000 characters: the master reads it before it asks again',
    );
  }
  return { decision: 'return', reason };
}

export interface ApprovalView extends ReleaseApprovalView {
  runId: string;
}

export async function approvalViews(rows: readonly ReleaseApprovalRow[]): Promise<ApprovalView[]> {
  const people = await peopleOf(rows.flatMap((r) => [r.requestedByUser, r.decidedByUser]));
  const who = (id: string) => ({
    id,
    name: people.get(id)?.name ?? 'Unknown',
    kind: people.get(id)?.kind ?? 'human',
  });
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    requestedBy: who(r.requestedByUser),
    requestedAt: r.requestedAt.toISOString(),
    evidence: {
      environment: r.evidenceEnvironment,
      commit: r.evidenceCommit,
      reading: r.evidenceReading,
    },
    note: r.note,
    decision: r.decision ?? null,
    decidedBy: r.decidedByUser ? who(r.decidedByUser) : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    reason: r.reason,
  }));
}

export async function approvalsOfRuns(runIds: readonly string[]): Promise<ReleaseApprovalRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select()
    .from(releaseApprovals)
    .where(inArray(releaseApprovals.runId, [...runIds]))
    .orderBy(desc(releaseApprovals.requestedAt), desc(releaseApprovals.id));
}

async function evidenceEnvironment(projectId: string, name: string): Promise<void> {
  const read = await readReleasePath(projectId);
  if (!read.ok) {
    throw refuseRelease(
      'RELEASE_APPROVAL_PATH_UNREADABLE',
      `the project document cannot be read as a release path (${read.reason}), so the environment the evidence names cannot be checked`,
    );
  }
  const envs = environmentsOf(read.path.document);
  const env = envs.find((e) => e.name === name);
  const before = envs.filter((e) => e.declaration.tier !== 'production').map((e) => e.name);
  if (!env || env.declaration.tier === 'production') {
    throw refuseRelease(
      'RELEASE_APPROVAL_EVIDENCE_ENVIRONMENT',
      `evidence names environment ${JSON.stringify(name)}, which ${env ? 'is production itself' : 'the project document does not declare'}; approval rests on a reading from an environment before production (declared: ${before.join(', ') || 'none'})`,
    );
  }
}

async function runOf(runId: string) {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      releaseVersion: pipelineRuns.releaseVersion,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return run ?? null;
}

// approval is asked for while the run is still open and has shipped nothing; asking on a concluded run would record an approval nothing can act on
export async function requestApproval(input: {
  projectId: string;
  runId: string;
  userId: string;
  body: ApprovalRequest;
}): Promise<ApprovalView> {
  const { projectId, runId, userId, body } = input;
  const run = await runOf(runId);
  if (!run || run.projectId !== projectId) {
    throw notFound('release batch not found');
  }
  if (run.status !== 'running' || run.releasedAt !== null) {
    throw refuseRelease(
      'RELEASE_RUN_CONCLUDED',
      `release run ${runId} is ${run.releasedAt ? 'shipped' : run.status}; approval is asked for an open run before production`,
    );
  }
  await evidenceEnvironment(projectId, body.evidence.environment);
  const [row] = await db
    .insert(releaseApprovals)
    .values({
      projectId,
      runId,
      requestedByUser: userId,
      evidenceEnvironment: body.evidence.environment,
      evidenceCommit: body.evidence.commit,
      evidenceReading: body.evidence.reading,
      note: body.note ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    throw refuseRelease(
      'RELEASE_APPROVAL_PENDING',
      `release run ${runId} already has a request waiting for an admin; it is decided before another is asked`,
    );
  }
  const [view] = await approvalViews([row]);
  return view as ApprovalView;
}

export async function decideApproval(input: {
  projectId: string;
  runId: string;
  approvalId: string;
  userId: string;
  decision: Decision;
}): Promise<ApprovalView> {
  const { projectId, runId, approvalId, userId, decision } = input;
  const denied = await permissionRefusalFor(
    actorFor(userId),
    'releases.approve',
    projectResource(projectId),
    'approving or returning a release',
  );
  if (denied) throw new RefusalError([denied], denied.code);
  const row = await db.transaction(async (tx) => {
    const [decided] = await tx
      .update(releaseApprovals)
      .set({
        decision: decision.decision === 'approve' ? 'approved' : 'returned',
        decidedByUser: userId,
        decidedAt: sql`now()`,
        reason: decision.decision === 'return' ? decision.reason : null,
      })
      .where(
        and(
          eq(releaseApprovals.id, approvalId),
          eq(releaseApprovals.runId, runId),
          eq(releaseApprovals.projectId, projectId),
          isNull(releaseApprovals.decision),
        ),
      )
      .returning();
    if (decided?.decision && decided.decidedAt) {
      await emitEvent(tx, 'release.approvalDecided', {
        projectId,
        runId,
        approvalId,
        decision: decided.decision,
        reason: decided.reason,
        decidedBy: userId,
        decidedAt: decided.decidedAt.toISOString(),
      });
    }
    return decided;
  });
  if (!row) {
    const [held] = await db
      .select()
      .from(releaseApprovals)
      .where(and(eq(releaseApprovals.id, approvalId), eq(releaseApprovals.runId, runId)))
      .limit(1);
    if (!held || held.projectId !== projectId) {
      throw notFound(`run ${runId} holds no approval request ${approvalId}`);
    }
    throw refuseRelease(
      'RELEASE_APPROVAL_NOT_PENDING',
      `approval request ${approvalId} was already ${held.decision} at ${held.decidedAt?.toISOString()}; a request is decided once`,
    );
  }
  const [view] = await approvalViews([row]);
  return view as ApprovalView;
}

// an attempt on a run whose latest request is pending or returned is refused: the attempts of a release run are its production acts, and approval is what lets the master make them
// on a project whose document sets `release.approval.required`, a run with no approval is refused too, so the rule holds whether or not the master asked; who approved was gated by releases.approve when it was decided
export async function assertApprovalAllowsAttempt(runId: string, projectId: string): Promise<void> {
  const [latest] = await db
    .select({
      decision: releaseApprovals.decision,
      reason: releaseApprovals.reason,
    })
    .from(releaseApprovals)
    .where(eq(releaseApprovals.runId, runId))
    .orderBy(desc(releaseApprovals.requestedAt), desc(releaseApprovals.id))
    .limit(1);
  const required = await approvalRequired(projectId);
  if (!latest) {
    if (!required) return;
    throw refuseRelease(
      'RELEASE_APPROVAL_REQUIRED',
      `project ${projectId} requires release approval (project document \`release.approval.required\`), and release run ${runId} has none: ask with POST /api/projects/${projectId}/release-batches/${runId}/approvals and wait for an admin to approve it`,
    );
  }
  if (latest.decision === 'approved') return;
  if (latest.decision === null) {
    throw refuseRelease(
      'RELEASE_AWAITING_APPROVAL',
      `release run ${runId} waits for an admin to approve it; no production act is recorded before the decision`,
    );
  }
  throw refuseRelease(
    'RELEASE_APPROVAL_RETURNED',
    `release run ${runId} was returned (${latest.reason}); ask for approval again once that is answered`,
  );
}
