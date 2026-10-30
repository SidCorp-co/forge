// A run a PERSON declares for review on a box (forge-core-61, 2026-10-30: the owner's own review
// session, and agenfold, which has no master, had no route to a testing identity and fell back to
// local credential files). It is the declared run a master's `run declare` opens (`run-session.ts`),
// one `run_session` under one one-shot run on that box, so the value door reads it as it reads any:
// by its id, under that box's credential. What differs is who declared it and what it holds: it is
// opened by core for the person, under no master, it takes no issue (a review reads, it works
// nothing), and it ends at the time its declaration names (`REVIEW_RUN_METADATA_KEY`).

import {
  REVIEW_RUN_METADATA_KEY,
  type ReviewRunDeclaration,
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { and, eq, sql } from 'drizzle-orm';
import { insertSessionRow } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { heldIssuePrefixes, recordActivityTx } from '../issues/index.js';
import { canonicalIssueKey, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { insertOneShotRun } from '../pipeline/index.js';
import { projectAdmission, runnerNotAdmitted } from './pool-admission.js';
import { refuseDevice } from './refusals.js';

/** The activity a review run's declaration is recorded under, on the issue it reviews. */
export const REVIEW_RUN_DECLARED = 'review_run.declared';

interface ReviewRun {
  sessionId: string;
  runId: string;
  box: { id: string; name: string };
}

/**
 * The box `named` (its id or its name) among those a runner of the project's organisation is bound
 * to. An unknown box and a box of another organisation are the same refusal, so this door says
 * nothing of a box the caller's organisation does not hold.
 */
async function boxOfOrg(projectId: string, named: string): Promise<{ id: string; name: string }> {
  const boxes = (await db.execute(sql`
    SELECT DISTINCT d.id, d.name
      FROM devices d
      JOIN runners rn ON rn.device_id = d.id
      JOIN projects p ON p.id = rn.project_id
     WHERE p.org_id = (SELECT org_id FROM projects WHERE id = ${projectId})
       AND d.status <> 'revoked'
       AND (d.id::text = ${named} OR d.name = ${named})
  `)) as unknown as Array<{ id: string; name: string }>;
  const byId = boxes.find((b) => b.id === named);
  if (byId) return byId;
  const [only, ...others] = boxes;
  if (!only) {
    throw refuseDevice(
      'REVIEW_RUN_BOX_NOT_IN_ORG',
      `no box named \`${named}\` is paired to this project's organisation (no runner of any of its projects is bound to a live box of that id or name); name a box the organisation's runners run on, by its id or its name.`,
      '/box',
    );
  }
  if (others.length > 0) {
    throw refuseDevice(
      'REVIEW_RUN_BOX_AMBIGUOUS',
      `${boxes.length} of this organisation's boxes are named \`${named}\` (${boxes.map((b) => b.id).join(', ')}); name the box by its id.`,
      '/box',
    );
  }
  return only;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReviewedIssue {
  id: string;
  seq: number;
  status: string;
}

/** The issue `named` (its id, or a key this project answers to) is, refused where it is none of the project's. */
async function issueOfProject(projectId: string, named: string): Promise<ReviewedIssue> {
  const notHere = (why: string) =>
    refuseDevice(
      'REVIEW_RUN_ISSUE_NOT_IN_PROJECT',
      `${why} A review run reviews one issue of the project it is declared in; name it by its key or its id.`,
      '/issue',
    );
  const columns = { id: issues.id, seq: issues.issSeq, status: issues.status };
  if (UUID.test(named)) {
    const [row] = await db
      .select({ ...columns, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, named))
      .limit(1);
    if (!row || row.projectId !== projectId) {
      throw notHere(`issue ${named} is no issue of project ${projectId}.`);
    }
    return { id: row.id, seq: row.seq, status: row.status };
  }
  const accepts = issueRefNeedsHeldPrefixes(named) ? await heldIssuePrefixes(projectId) : [];
  const parsed = parseIssueRef(named, accepts);
  if (!parsed.ok) throw notHere(parsed.message);
  const [row] = await db
    .select(columns)
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, parsed.issSeq)))
    .limit(1);
  if (!row) throw notHere(`project ${projectId} holds no issue \`${named}\`.`);
  return row;
}

/**
 * Open a review run over one issue on a box that serves its project, for the person declaring it.
 * Refused by name where the box is not the organisation's, or does not serve the project.
 */
export async function openReviewRun(args: {
  projectId: string;
  box: string;
  issue: string;
  declaration: ReviewRunDeclaration;
}): Promise<ReviewRun & { issue: string }> {
  const issue = await issueOfProject(args.projectId, args.issue);
  const box = await boxOfOrg(args.projectId, args.box);
  const admission = await projectAdmission({ projectId: args.projectId, deviceId: box.id });
  if (!admission.admitted) {
    throw runnerNotAdmitted({
      reason: admission.reason,
      projectId: args.projectId,
      deviceId: box.id,
    });
  }
  const key = canonicalIssueKey(issue.seq);
  const metadata = {
    type: RUN_SESSION_KIND,
    deviceId: box.id,
    // a review takes nothing, so a box lost under it hands nothing back
    [RUN_ISSUES_METADATA_KEY]: [],
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: issue.status },
    [REVIEW_RUN_METADATA_KEY]: args.declaration,
    role: 'review',
  };
  const opened = await db.transaction(async (tx) => {
    const run = await insertOneShotRun(tx, {
      projectId: args.projectId,
      kind: 'system',
      metadata,
    });
    const now = new Date();
    const session = await insertSessionRow(tx, {
      projectId: args.projectId,
      deviceId: box.id,
      userId: args.declaration.declaredBy,
      pipelineRunId: run.id,
      title: `review: ${key}`,
      kind: RUN_SESSION_KIND,
      parentSessionId: null,
      status: 'running',
      startedAt: now,
      lastHeartbeatAt: now,
      metadata: { terminalName: `review ${key}`, deviceId: box.id },
    });
    await recordActivityTx(tx, {
      issueId: issue.id,
      actor: { type: 'user', id: args.declaration.declaredBy, agency: 'human' },
      action: REVIEW_RUN_DECLARED,
      payload: {
        sessionId: session.id,
        runId: run.id,
        deviceId: box.id,
        box: box.name,
        profile: args.declaration.profile,
        expiresAt: args.declaration.expiresAt,
      },
    });
    return { sessionId: session.id, runId: run.id };
  });
  logger.info(
    { ...opened, deviceId: box.id, issue: key, profile: args.declaration.profile },
    'review-run: opened for a person',
  );
  return { ...opened, box, issue: key };
}
