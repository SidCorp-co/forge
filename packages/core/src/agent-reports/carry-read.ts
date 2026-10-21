/**
 * The retired agent reports as the carry into Forge feedback reads them (REQ-47 BC-8): each with the
 * account that filed it, which is the reporting session's user (`agent_sessions.user_id` through
 * `agent_reports.session_id`). A report whose session or user is gone has no author, and is said so.
 */

import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentReports, agentSessions, users } from '../db/schema.js';

export async function carriableReports() {
  return db
    .select({
      id: agentReports.id,
      projectId: agentReports.projectId,
      issueId: agentReports.issueId,
      runId: agentReports.runId,
      kind: agentReports.kind,
      severity: agentReports.severity,
      target: agentReports.target,
      targetRef: agentReports.targetRef,
      summary: agentReports.summary,
      detail: agentReports.detail,
      suggestion: agentReports.suggestion,
      signalKey: agentReports.signalKey,
      sessionId: agentReports.sessionId,
      triage: agentReports.triage,
      writtenLang: agentReports.writtenLang,
      createdAt: agentReports.createdAt,
      authorId: users.id,
      authorKind: users.kind,
    })
    .from(agentReports)
    .leftJoin(agentSessions, eq(agentSessions.id, agentReports.sessionId))
    .leftJoin(users, eq(users.id, agentSessions.userId))
    .orderBy(asc(agentReports.createdAt), asc(agentReports.id));
}

export type CarriableReport = Awaited<ReturnType<typeof carriableReports>>[number];
