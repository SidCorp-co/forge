/**
 * Where a proposal goes (REQ-49): the one target it names, a requirement at one of its revisions, a
 * feedback item or an issue, or, for a next revision that names none, the item of the returned
 * mockup it revises.
 */

import type { MockupTargetInput, ProposeMockupRequest } from '@forge/contracts/mockups';
import type { RevisionState } from '@forge/contracts/requirements';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { feedbackRefIn, issueRefIn, requirementRefIn } from '../feedback/index.js';
import { type MockupRow, mockupKey, rowIn } from './read.js';
import { type MockupRefusal, revisesTargetRefusal, revisionRefusal } from './rules.js';

export interface Target {
  requirementId: string | null;
  revision: number | null;
  feedbackId: string | null;
  issueId: string | null;
  /** What a refusal calls it: REQ-n rN, FB-n or ISS-n. */
  label: string;
}

const invalidTarget = (path: string, detail: string): MockupRefusal => ({
  code: 'MOCKUP_TARGET_INVALID',
  path,
  detail,
});

const NONE = { requirementId: null, revision: null, feedbackId: null, issueId: null };

async function requirementAt(
  projectId: string,
  ref: string,
  revision: number | null,
): Promise<Target | MockupRefusal> {
  const req = await requirementRefIn(projectId, ref, '/target/requirement');
  if ('code' in req) return invalidTarget(req.path, req.detail);
  const [head] = await db
    .select({ current: requirements.currentRevision })
    .from(requirements)
    .where(eq(requirements.id, req.id));
  // a next revision that names no target goes to the requirement's open revision, else its head
  const at =
    revision ??
    (
      await db
        .select({ revision: requirementRevisions.revision })
        .from(requirementRevisions)
        .where(
          and(
            eq(requirementRevisions.requirementId, req.id),
            inArray(requirementRevisions.state, ['draft', 'proposed', 'current']),
          ),
        )
        .orderBy(desc(requirementRevisions.revision))
        .limit(1)
    )[0]?.revision ??
    head?.current ??
    1;
  const [rev] = await db
    .select({ state: requirementRevisions.state })
    .from(requirementRevisions)
    .where(
      and(eq(requirementRevisions.requirementId, req.id), eq(requirementRevisions.revision, at)),
    );
  const refused = revisionRefusal(
    req.key,
    at,
    (rev?.state as RevisionState | undefined) ?? null,
    head?.current ?? null,
  );
  if (refused) return refused;
  return { ...NONE, requirementId: req.id, revision: at, label: `${req.key} r${at}` };
}

/** The one target a proposal names, inside `projectId`, or the refusal naming why it is not one. */
export async function resolveMockupTarget(
  projectId: string,
  target: MockupTargetInput,
  userId: string,
): Promise<Target | MockupRefusal> {
  if ('issue' in target) {
    const issue = await issueRefIn(projectId, target.issue, userId, '/target/issue');
    if ('code' in issue) return invalidTarget(issue.path, issue.detail);
    return { ...NONE, issueId: issue.id, label: issue.key };
  }
  if ('feedback' in target) {
    const item = await feedbackRefIn(projectId, target.feedback, '/target/feedback');
    if ('code' in item) return invalidTarget(item.path, item.detail);
    return { ...NONE, feedbackId: item.id, label: item.key };
  }
  return requirementAt(projectId, target.requirement, target.revision ?? null);
}

const itemOf = (t: {
  requirementId: string | null;
  feedbackId: string | null;
  issueId: string | null;
}) => t.requirementId ?? t.feedbackId ?? t.issueId ?? '';

/** The returned mockup a proposal revises, or the refusal naming why `ref` is not one in this project. */
export async function revisedRow(
  projectId: string,
  ref: string,
): Promise<MockupRow | MockupRefusal> {
  try {
    return await rowIn(db, projectId, ref);
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      return { code: 'MOCKUP_REVISES_INVALID', path: '/revises', detail: err.message };
    }
    throw err;
  }
}

/**
 * Where a proposal goes: its named target, which a next revision must share with the mockup it
 * revises, or with none named, that mockup's item (a requirement at its open revision or head).
 */
export async function proposalTarget(
  projectId: string,
  body: ProposeMockupRequest,
  userId: string,
  revised: MockupRow | null,
): Promise<Target | MockupRefusal> {
  if (body.target) {
    const named = await resolveMockupTarget(projectId, body.target, userId);
    if ('code' in named || !revised) return named;
    return (
      revisesTargetRefusal(mockupKey(revised.mockupSeq), itemOf(revised), itemOf(named)) ?? named
    );
  }
  if (!revised) {
    return invalidTarget(
      '/target',
      'a mockup names its target: { requirement, revision }, { feedback } or { issue }; only a next revision (revises) may leave it out.',
    );
  }
  if (revised.requirementId) return requirementAt(projectId, revised.requirementId, null);
  return {
    ...NONE,
    feedbackId: revised.feedbackId,
    issueId: revised.issueId,
    label: mockupKey(revised.mockupSeq),
  };
}
