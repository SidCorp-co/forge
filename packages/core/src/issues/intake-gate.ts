import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issueLabels, labels, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';

export interface IntakeGateConfig {
  enabled: boolean;
  /** Notify the project owner on gated arrivals. Default true. */
  notify: boolean;
}

export interface IntakeGateDecision {
  status: IssueStatus;
  gated: boolean;
}

export const INTAKE_LABEL_NAME = 'intake';
const INTAKE_LABEL_COLOR = '#f59e0b';

interface StoredPipelineConfig {
  intakeGate?: { enabled?: unknown; notify?: unknown };
  githubIntake?: { enabled?: unknown };
}

async function readPipelineConfig(projectId: string): Promise<StoredPipelineConfig> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { pipelineConfig?: StoredPipelineConfig };
  return ac.pipelineConfig ?? {};
}

function intakeGateOf(cfg: StoredPipelineConfig): IntakeGateConfig {
  return {
    enabled: cfg.intakeGate?.enabled === true,
    notify: cfg.intakeGate?.notify !== false,
  };
}

/** Read the project's intake-gate config (absent → disabled). */
export async function resolveIntakeGate(projectId: string): Promise<IntakeGateConfig> {
  return intakeGateOf(await readPipelineConfig(projectId));
}

export type ExternalIntakeDecision =
  | { admitted: false; reason: 'github-intake-closed' }
  | { admitted: true; status: IssueStatus; gated: boolean };

export async function admitGithubIssue(projectId: string): Promise<ExternalIntakeDecision> {
  const cfg = await readPipelineConfig(projectId);
  if (cfg.githubIntake?.enabled !== true) {
    return { admitted: false, reason: 'github-intake-closed' };
  }
  const gate = intakeGateOf(cfg);
  return gate.enabled
    ? { admitted: true, status: 'draft', gated: true }
    : { admitted: true, status: 'open', gated: false };
}

/**
 * Decide the effective create status. Only a would-be `open` create is
 * rewritten; everything else passes through so system/agent drafts and
 * explicit `on_hold` creates keep their meaning.
 */
export async function applyIntakeGate(
  projectId: string,
  requestedStatus: IssueStatus,
): Promise<IntakeGateDecision> {
  if (requestedStatus !== 'open') return { status: requestedStatus, gated: false };
  const cfg = await resolveIntakeGate(projectId);
  if (!cfg.enabled) return { status: 'open', gated: false };
  return { status: 'draft', gated: true };
}

/**
 * Post-create bookkeeping for a gated issue: attach the `intake` label
 * (find-or-create per project) and notify the project owner. Best-effort —
 * a labelling/notification failure must never fail the create that already
 * committed; it logs and moves on.
 */
export async function finalizeIntake(
  projectId: string,
  issue: { id: string; title: string },
): Promise<void> {
  try {
    let [label] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.projectId, projectId), eq(labels.name, INTAKE_LABEL_NAME)))
      .limit(1);
    if (!label) {
      const inserted = await db
        .insert(labels)
        .values({ projectId, name: INTAKE_LABEL_NAME, color: INTAKE_LABEL_COLOR })
        .onConflictDoNothing()
        .returning({ id: labels.id });
      label =
        inserted[0] ??
        (
          await db
            .select({ id: labels.id })
            .from(labels)
            .where(and(eq(labels.projectId, projectId), eq(labels.name, INTAKE_LABEL_NAME)))
            .limit(1)
        )[0];
    }
    if (label) {
      await db
        .insert(issueLabels)
        .values({ issueId: issue.id, labelId: label.id })
        .onConflictDoNothing();
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId, issueId: issue.id },
      'intake-gate: failed to attach intake label',
    );
  }

  try {
    const cfg = await resolveIntakeGate(projectId);
    if (!cfg.notify) return;
    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project?.createdBy) return;
    await emitNotification({
      userId: project.createdBy,
      projectId,
      issueId: issue.id,
      type: 'intake_pending',
      title: 'Issue awaiting intake review',
      body: `"${issue.title}" was parked at draft by the intake gate — approve (draft → open) to let it enter the pipeline, or close to reject.`,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId, issueId: issue.id },
      'intake-gate: failed to notify owner',
    );
  }
}
