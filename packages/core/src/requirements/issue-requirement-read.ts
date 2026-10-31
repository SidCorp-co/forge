/**
 * The requirement an issue delivers, read through the issue. A run is fenced to its issue's project,
 * and since an issue may deliver a sibling project's requirement (`issue-projects.ts`), reading that
 * requirement on its own project's routes was refused `PAT_PROJECT_OUTSIDE_FENCE`: the run could not
 * read the criteria it traces. This read is authorised by the caller on the issue's project and
 * answers only the requirement the issue's own `requirement_id` names — its current revision as the
 * requirement's read serves it, and its latest baseline — never another record of that project.
 */

import type { IssueRequirementRead } from '@forge/contracts/issue-requirement';
import { changedSincePlan, requirementKey } from '@forge/contracts/requirements';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import {
  type RequirementStatus,
  requirementBaselines,
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { peopleOf } from '../lib/people.js';
import { pictureRowsOf } from './picture-read.js';
import { changedTracedOf } from './plan-drift.js';
import { baselinePinRowsOf, baselineViews } from './read.js';
import { revisionBase, revisionView } from './revision-view.js';

/** The requirement `issueId` delivers, whichever project of its organization holds it; the caller has authorised the issue. */
export async function issueRequirementOf(issueId: string): Promise<IssueRequirementRead> {
  const [issue] = await db
    .select({
      projectId: issues.projectId,
      requirementId: issues.requirementId,
      plan: issues.plan,
      plannedRevision: issues.plannedRevision,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (!issue) throw new Error(`requirements: no issue ${issueId} to read the requirement of`);
  if (!issue.requirementId) return { issueId, requirement: null };
  const requirementId = issue.requirementId;
  const [row] = await db
    .select({
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      projectId: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(requirements)
    .innerJoin(projects, eq(projects.id, requirements.projectId))
    .where(eq(requirements.id, requirementId));
  if (!row)
    throw new Error(
      `requirements: issue ${issueId} names requirement ${requirementId}, which no row holds`,
    );
  const current = row.currentRevision;
  const [revisions, criteria, baselines, pins, pictures, changed] = await Promise.all([
    current === null
      ? Promise.resolve([])
      : db
          .select()
          .from(requirementRevisions)
          .where(
            and(
              eq(requirementRevisions.requirementId, requirementId),
              eq(requirementRevisions.revision, current),
            ),
          ),
    db
      .select()
      .from(requirementCriteria)
      .where(eq(requirementCriteria.requirementId, requirementId)),
    db
      .select()
      .from(requirementBaselines)
      .where(eq(requirementBaselines.requirementId, requirementId))
      .orderBy(desc(requirementBaselines.revision), desc(requirementBaselines.seq))
      .limit(1),
    baselinePinRowsOf(requirementId),
    pictureRowsOf(requirementId),
    changedTracedOf(db, [issueId]),
  ]);
  const people = await peopleOf([
    ...revisions.flatMap((r) => [r.authorId, r.decidedBy]),
    ...baselines.map((b) => b.agreedBy),
    ...pictures.map((p) => p.writtenBy),
  ]);
  const name = (id: string | null) => (id === null ? null : (people.get(id)?.name ?? null));
  const [head] = revisions;
  const changedTraced = changed.get(issueId) ?? [];
  const project = { id: row.projectId, slug: row.slug, name: row.name };
  const other = row.projectId === issue.projectId ? null : project;
  const key = requirementKey(row.reqSeq);
  return {
    issueId,
    requirement: {
      id: requirementId,
      key,
      displayKey: other ? `${other.slug}/${key}` : key,
      project,
      otherProject: other,
      title: row.title,
      status: row.status as RequirementStatus,
      currentRevision: current,
      revision: head
        ? revisionView(head, criteria, people, pictures, revisionBase(revisions, head, current))
        : null,
      agreed: baselineViews(baselines, pins, name)[0] ?? null,
      plannedRevision: issue.plannedRevision,
      changedSincePlan: changedSincePlan({
        plan: issue.plan,
        plannedRevision: issue.plannedRevision,
        currentRevision: current,
        changedTraced,
      }),
      changedTraced,
    },
  };
}
