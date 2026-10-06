/**
 * Resolving what a feedback write names — its target, an issue, a requirement — inside its own
 * project, answering the refusal by name (FEEDBACK_TARGET_UNKNOWN, FEEDBACK_TARGET_NOT_IN_PROJECT)
 * rather than a 404, because a target is a body field, not the path.
 */

import {
  type FeedbackRefusal,
  type FeedbackTargetType,
  feedbackKey,
} from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { activeIssuePrefix, isUuid, resolveIssueRouteRef } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { runWearingVersion } from '../pipeline/index.js';
import { type Row, rowIn } from './read.js';
import type { TargetFields } from './rules.js';

interface ResolvedTarget {
  type: FeedbackTargetType;
  requirementId: string | null;
  issueId: string | null;
  releaseRunId: string | null;
  workflowId: string | null;
  screen: string | null;
}

const unknownTarget = (path: string, detail: string): FeedbackRefusal => ({
  code: 'FEEDBACK_TARGET_UNKNOWN',
  path,
  detail,
});
const elsewhere = (path: string, detail: string): FeedbackRefusal => ({
  code: 'FEEDBACK_TARGET_NOT_IN_PROJECT',
  path,
  detail,
});

/** An issue of `projectId` by key or uuid, or the refusal naming why it is not one. */
export async function issueRefIn(
  projectId: string,
  ref: string,
  userId: string,
  path: string,
): Promise<{ id: string; key: string; status: string } | FeedbackRefusal> {
  try {
    const issue = await resolveIssueRouteRef(ref, projectId, userId);
    if (issue.projectId !== projectId) {
      return elsewhere(
        path,
        `issue ${ref} belongs to another project; feedback names a target of its own project.`,
      );
    }
    return {
      id: issue.id,
      key: formatIssueRef(await activeIssuePrefix(projectId), issue.issSeq),
      status: issue.status,
    };
  } catch (err) {
    if (err instanceof HTTPException && err.status !== 500) {
      return unknownTarget(path, `${ref} names no issue of this project (${err.message}).`);
    }
    throw err;
  }
}

/** A feedback item of `projectId` by key or uuid, or the refusal naming why it is not one. */
export async function feedbackRefIn(
  projectId: string,
  ref: string,
  path: string,
): Promise<{ id: string; key: string } | FeedbackRefusal> {
  try {
    const row = await rowIn(db, projectId, ref);
    return { id: row.id, key: feedbackKey(row.fbSeq) };
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      return unknownTarget(path, `${ref} names no feedback item of this project.`);
    }
    throw err;
  }
}

/** A requirement of `projectId` by key or uuid, or the refusal naming why it is not one. */
export async function requirementRefIn(
  projectId: string,
  ref: string,
  path: string,
): Promise<{ id: string; key: string; status: string; title: string } | FeedbackRefusal> {
  const seq = /^(?:REQ-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = isUuid(ref) ? ref : null;
  if (!seq && !uuid)
    return unknownTarget(path, `"${ref}" is neither a requirement uuid nor a key like REQ-3.`);
  const [row] = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      seq: requirements.reqSeq,
      status: requirements.status,
      title: requirements.title,
    })
    .from(requirements)
    .where(
      seq
        ? and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, Number(seq)))
        : eq(requirements.id, uuid as string),
    );
  if (!row) return unknownTarget(path, `${ref} names no requirement of this project.`);
  if (row.projectId !== projectId) {
    return elsewhere(path, `requirement ${ref} belongs to another project.`);
  }
  return { id: row.id, key: requirementKey(row.seq), status: row.status, title: row.title };
}

async function releaseRefIn(projectId: string, ref: string, path: string) {
  const row = isUuid(ref)
    ? (
        await db
          .select({ id: pipelineRuns.id, projectId: pipelineRuns.projectId })
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, ref))
      )[0]
    : await runWearingVersion(projectId, ref.trim()).then(
        (run) => run && { id: run.id, projectId },
      );
  if (!row)
    return unknownTarget(path, `${ref} names no release of this project; name its version.`);
  if (row.projectId !== projectId)
    return elsewhere(path, `release ${ref} belongs to another project.`);
  return { id: row.id };
}

async function workflowRefIn(projectId: string, ref: string, path: string) {
  const [row] = await db
    .select({ id: projectWorkflows.id, projectId: projectWorkflows.projectId })
    .from(projectWorkflows)
    .where(
      isUuid(ref)
        ? eq(projectWorkflows.id, ref)
        : and(eq(projectWorkflows.projectId, projectId), eq(projectWorkflows.flow, ref.trim())),
    );
  if (!row) return unknownTarget(path, `${ref} names no workflow of this project; name its flow.`);
  if (row.projectId !== projectId)
    return elsewhere(path, `workflow ${ref} belongs to another project.`);
  return { id: row.id };
}

const isRefusal = (v: unknown): v is FeedbackRefusal =>
  typeof v === 'object' && v !== null && 'code' in v && 'detail' in v;

/** The one target a create names, resolved inside `projectId`, or the refusal naming it. */
export async function resolveTarget(
  projectId: string,
  fields: TargetFields,
  userId: string,
): Promise<ResolvedTarget | FeedbackRefusal> {
  const empty = {
    requirementId: null,
    issueId: null,
    releaseRunId: null,
    workflowId: null,
    screen: null,
  };
  if (fields.requirement) {
    const r = await requirementRefIn(projectId, fields.requirement, '/requirement');
    return isRefusal(r) ? r : { ...empty, type: 'requirement', requirementId: r.id };
  }
  if (fields.issue) {
    const r = await issueRefIn(projectId, fields.issue, userId, '/issue');
    return isRefusal(r) ? r : { ...empty, type: 'issue', issueId: r.id };
  }
  if (fields.release) {
    const r = await releaseRefIn(projectId, fields.release, '/release');
    return isRefusal(r) ? r : { ...empty, type: 'release', releaseRunId: r.id };
  }
  if (fields.workflow) {
    const r = await workflowRefIn(projectId, fields.workflow, '/workflow');
    return isRefusal(r) ? r : { ...empty, type: 'workflow', workflowId: r.id };
  }
  return { ...empty, type: 'screen', screen: fields.screen ?? '' };
}

export { isRefusal };

export const targetTypeOf = (r: Row): FeedbackTargetType =>
  r.requirementId
    ? 'requirement'
    : r.issueId
      ? 'issue'
      : r.releaseRunId
        ? 'release'
        : r.workflowId
          ? 'workflow'
          : r.contractVersion
            ? 'contract'
            : 'screen';
