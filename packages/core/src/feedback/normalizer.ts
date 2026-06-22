import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { feedbackReports, memoryCandidates } from '../db/schema.js';
import { logger } from '../logger.js';
import { upsertCandidate } from '../memory/candidates-accrual.js';
import type { HooksBus } from '../pipeline/hooks.js';

type Outcome = 'completed' | 'failed';

async function foldReportsForJob(
  jobId: string,
  projectId: string,
  issueId: string | null,
  outcome: Outcome,
  failureKind?: string | null,
): Promise<void> {
  const reports = await db
    .select()
    .from(feedbackReports)
    .where(and(eq(feedbackReports.jobId, jobId), isNull(feedbackReports.candidateId)))
    .limit(env.FEEDBACK_MAX_PER_JOB);

  if (reports.length === 0) return;

  for (const report of reports) {
    const evidenceRunId = report.runId ?? jobId;
    const evidenceIssueId = report.issueId ?? issueId ?? '';
    const at = report.createdAt.toISOString();

    // Extra outcome fields stored in evidence jsonb for curator self-bias check.
    // CandidateInput.evidence is structurally matched at runId/issueId/at; extra
    // fields are preserved in the jsonb column without breaking accrual dedup.
    const evidence = {
      runId: evidenceRunId,
      issueId: evidenceIssueId,
      at,
      outcome,
      ...(failureKind ? { failureKind } : {}),
      jobId,
    };

    const summary = buildSummary(report);

    await upsertCandidate(projectId, {
      signalType: 'agent_self_report',
      signalKey: report.signalKey,
      summary,
      evidence,
    });

    // Back-set candidate_id on the report after upsert.
    const [candidate] = await db
      .select({ id: memoryCandidates.id })
      .from(memoryCandidates)
      .where(
        and(
          eq(memoryCandidates.projectId, projectId),
          eq(memoryCandidates.signalType, 'agent_self_report'),
          eq(memoryCandidates.signalKey, report.signalKey),
        ),
      )
      .limit(1);

    if (candidate) {
      await db
        .update(feedbackReports)
        .set({ candidateId: candidate.id })
        .where(eq(feedbackReports.id, report.id));
    }
  }

  logger.info(
    { jobId, projectId, count: reports.length, outcome },
    'feedback.normalizer: folded reports into candidates',
  );
}

function buildSummary(report: typeof feedbackReports.$inferSelect): string {
  const ref = report.targetRef ? `:${report.targetRef}` : '';
  return `[agent_self_report] ${report.kind}/${report.severity} on ${report.target}${ref} — ${report.summary}`;
}

let registered = false;

export function registerFeedbackNormalizer(bus: HooksBus): void {
  if (registered) return;
  registered = true;

  bus.on('jobCompleted', (p) => {
    if (!p.issueId) return;
    queueMicrotask(() => {
      foldReportsForJob(p.jobId, p.projectId, p.issueId, 'completed').catch((err) => {
        logger.warn(
          { err: (err as Error).message, jobId: p.jobId },
          'feedback.normalizer: fold failed (jobCompleted)',
        );
      });
    });
  });

  bus.on('jobFailed', (p) => {
    if (!p.issueId) return;
    queueMicrotask(() => {
      foldReportsForJob(
        p.jobId,
        p.projectId,
        p.issueId,
        'failed',
        p.failureKind,
      ).catch((err) => {
        logger.warn(
          { err: (err as Error).message, jobId: p.jobId },
          'feedback.normalizer: fold failed (jobFailed)',
        );
      });
    });
  });
}

export function resetFeedbackNormalizerForTest(): void {
  registered = false;
}
