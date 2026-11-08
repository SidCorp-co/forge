// The rows a feedback list's links name, each read by its own id (`list-read.ts:linkedOf`).

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerId } from '../db/read-memo.js';
import { pipelineRuns, projects } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';

/** The feedback items `ids` name, as `rootsOf` reads a duplicate's original. */
export const rootRowsOf = (ids: readonly string[]) =>
  rowsPerId(
    'feedbackRoots',
    ids,
    (some) =>
      db
        .select()
        .from(feedback)
        .where(inArray(feedback.id, [...some])),
    (r) => r.id,
  );

/**
 * The rows each read below answers by their own id: every project's asks in a read across
 * projects, one statement (`db/read-memo.ts:rowsPerId`). Each project's feedback list read its
 * releases, workflows, suggestions and providers on its own, so a person's fourteen projects sent
 * each once a project that held such feedback (ISS-1070 r15).
 */
export const releaseRowsOf = (releaseIds: readonly string[]) =>
  rowsPerId(
    'feedbackReleaseRow',
    releaseIds,
    (some) =>
      db
        .select({ id: pipelineRuns.id, version: pipelineRuns.releaseVersion })
        .from(pipelineRuns)
        .where(inArray(pipelineRuns.id, [...some])),
    (r) => r.id,
  );

export const workflowRowsOf = (workflowIds: readonly string[]) =>
  rowsPerId(
    'feedbackWorkflowRow',
    workflowIds,
    (some) =>
      db
        .select({
          id: projectWorkflows.id,
          flow: projectWorkflows.flow,
          document: projectWorkflows.document,
        })
        .from(projectWorkflows)
        .where(inArray(projectWorkflows.id, [...some])),
    (r) => r.id,
  );

export const suggestionRowsOf = (suggestionIds: readonly string[]) =>
  rowsPerId(
    'feedbackSuggestionRow',
    suggestionIds,
    (some) =>
      db
        .select({
          id: suggestions.id,
          status: suggestions.status,
          revisionState: requirementRevisions.state,
          revision: requirementRevisions.revision,
          requirementId: requirementRevisions.requirementId,
          requirementSeq: requirements.reqSeq,
        })
        .from(suggestions)
        .leftJoin(requirementRevisions, eq(requirementRevisions.fromSuggestionId, suggestions.id))
        .leftJoin(requirements, eq(requirements.id, requirementRevisions.requirementId))
        .where(inArray(suggestions.id, [...some])),
    (r) => r.id,
  );

export const providerRowsOf = (providerIds: readonly string[]) =>
  rowsPerId(
    'feedbackProviderRow',
    providerIds,
    (some) =>
      db
        .select({ id: projects.id, slug: projects.slug })
        .from(projects)
        .where(inArray(projects.id, [...some])),
    (r) => r.id,
  );
