/**
 * The rows a requirement's standing reads by requirement and by project, each read for every
 * project a person's read asks in one turn (`db/read-memo.ts:rowsPerId`, ISS-1070 r6).
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerId, rowsPerProject } from '../db/read-memo.js';
import {
  requirementBaselines,
  requirementCriteria,
  requirementRevisions,
} from '../db/schema-requirements.js';
import { runners } from '../db/schema-runners.js';
import { suggestions } from '../db/schema-suggestions.js';

/** Every revision of `ids`, newest first. */
export const revisionRowsOf = (ids: readonly string[]) =>
  rowsPerId(
    'standingRevisions',
    ids,
    (some) =>
      db
        .select({
          requirementId: requirementRevisions.requirementId,
          revision: requirementRevisions.revision,
          state: requirementRevisions.state,
          authorId: requirementRevisions.authorId,
          authorAgency: requirementRevisions.authorAgency,
          returnReason: requirementRevisions.returnReason,
          createdAt: requirementRevisions.createdAt,
          proposedAt: requirementRevisions.proposedAt,
          decidedAt: requirementRevisions.decidedAt,
        })
        .from(requirementRevisions)
        .where(inArray(requirementRevisions.requirementId, [...some]))
        .orderBy(desc(requirementRevisions.revision)),
    (r) => r.requirementId,
  );

/** Every criterion of `ids`, retired ones included. */
export const criteriaRowsOf = (ids: readonly string[]) =>
  rowsPerId(
    'standingCriteriaOfRequirements',
    ids,
    (some) =>
      db
        .select({
          requirementId: requirementCriteria.requirementId,
          id: requirementCriteria.id,
          code: requirementCriteria.code,
          body: requirementCriteria.body,
          sinceRevision: requirementCriteria.sinceRevision,
          retiredRevision: requirementCriteria.retiredRevision,
        })
        .from(requirementCriteria)
        .where(inArray(requirementCriteria.requirementId, [...some])),
    (r) => r.requirementId,
  );

/** Every agreed baseline of `ids`. */
export const baselineRowsOf = (ids: readonly string[]) =>
  rowsPerId(
    'standingBaselines',
    ids,
    (some) =>
      db
        .select({
          requirementId: requirementBaselines.requirementId,
          revision: requirementBaselines.revision,
          seq: requirementBaselines.seq,
          agreedAt: requirementBaselines.agreedAt,
        })
        .from(requirementBaselines)
        .where(inArray(requirementBaselines.requirementId, [...some])),
    (r) => r.requirementId,
  );

/** The proposed suggestions on these requirements, by kind. */
export const proposedSuggestionsOf = (ids: readonly string[]) =>
  rowsPerId(
    'proposedSuggestions',
    ids,
    (some) =>
      db
        .select({ requirementId: suggestions.requirementId, kind: suggestions.kind })
        .from(suggestions)
        .where(
          and(inArray(suggestions.requirementId, [...some]), eq(suggestions.status, 'proposed')),
        ),
    (r) => r.requirementId as string,
  );

/**
 * One runner bound to the project, if any, whatever its status: where none is bound no master can
 * act (FB-77); a runner briefly offline still carries its master.
 */
export const runnerBoundIn = async (projectId: string): Promise<boolean> =>
  (
    await rowsPerProject(
      'runnerBound',
      projectId,
      (ids) =>
        db
          .selectDistinctOn([runners.projectId], { projectId: runners.projectId })
          .from(runners)
          .where(inArray(runners.projectId, [...ids])),
      (r) => r.projectId as string,
    )
  ).length > 0;
