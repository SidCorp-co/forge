/**
 * The steward's last lessons pass on each project (ISS-1251 round 6), kept so a pass that fails or
 * moves nothing is read on the capabilities read rather than in core's log alone: from 2026-11-17
 * 12:10Z forge-dev's pass failed at its first step every ten minutes, and nothing on any read said so.
 * The steward writes one row per project per pass (`steward/lessons-pass-report.ts`); this reads it.
 */

import type { LessonsPassJudge, LessonsPassReport } from '@forge/contracts/capabilities';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { lessonsPassReports } from '../db/schema-lessons.js';

/** Keep a project's pass, replacing the one before it. */
export async function keepLessonsPassReport(
  projectId: string,
  report: LessonsPassReport,
): Promise<void> {
  const row = {
    startedAt: new Date(report.startedAt),
    endedAt: new Date(report.endedAt),
    stoppedStep: report.stopped?.step ?? null,
    stoppedError: report.stopped?.error ?? null,
    tally: report.tally,
    unanswered: report.unanswered,
  };
  await db
    .insert(lessonsPassReports)
    .values({ projectId, ...row })
    .onConflictDoUpdate({ target: lessonsPassReports.projectId, set: row });
}

/** The project's last pass, or null where none has run since passes were kept. */
export async function lessonsPassReportOf(projectId: string): Promise<LessonsPassReport | null> {
  const [row] = await db
    .select()
    .from(lessonsPassReports)
    .where(eq(lessonsPassReports.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return {
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    stopped:
      row.stoppedStep && row.stoppedError !== null
        ? { step: row.stoppedStep, error: row.stoppedError }
        : null,
    tally: row.tally,
    unanswered: row.unanswered.map((u) => ({ ...u, judge: u.judge as LessonsPassJudge })),
  };
}
