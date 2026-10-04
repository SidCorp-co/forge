import type { ReleaseNotes } from '@forge/contracts/release-notes';
import type { ReleaseCriterionView, ReleasePerson } from '@forge/contracts/releases';
import type { RequirementState } from '@forge/contracts/requirements';
import { criterionStandingOf, identityPhraseOf } from '@forge/contracts/verdict-identity';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs, organizationMembers, projectMembers, projects } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import {
  activeIssuePrefix,
  type CriterionWithVerdict,
  listCriteriaOf,
  reopenedAtOf,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { requirementKey, standingsOf } from '../requirements/index.js';
import type { CompletionFacts } from './release-view.js';

export interface IssueFact {
  id: string;
  key: string;
  title: string;
  status: string;
  updatedAt: Date;
  releaseNotes: ReleaseNotes | null;
  requirementId: string | null;
  criteria: ReleaseCriterionView[];
}

export interface ReleaseFacts {
  issues: Map<string, IssueFact>;
  requirements: Map<string, CompletionFacts>;
  cutters: Map<string, ReleasePerson>;
}

function criterionView(c: CriterionWithVerdict, voidedBy: Date | undefined): ReleaseCriterionView {
  const stale =
    voidedBy && c.latest && new Date(c.latest.createdAt).getTime() <= voidedBy.getTime();
  const latest = stale ? null : c.latest;
  return {
    n: c.n,
    statement: c.statement,
    standing: criterionStandingOf(latest),
    bc: null,
    identity: latest ? identityPhraseOf(latest) : null,
    reason: latest?.reason ?? null,
    judgedAt: latest?.createdAt ?? null,
    judgedBy: latest?.authorAgency ?? null,
  };
}

async function requirementFacts(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, CompletionFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      ownerId: requirements.ownerId,
      updatedAt: requirements.updatedAt,
      seq: requirements.reqSeq,
      title: requirements.title,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), inArray(requirements.id, [...ids])));
  const [standings, prefix, live] = await Promise.all([
    standingsOf(projectId, rows, null),
    activeIssuePrefix(projectId),
    db
      .select({
        id: issues.id,
        seq: issues.issSeq,
        status: issues.status,
        requirementId: issues.requirementId,
      })
      .from(issues)
      .where(and(inArray(issues.requirementId, [...ids]), ne(issues.status, 'dropped'))),
  ]);
  return new Map(
    rows.flatMap((r) => {
      const standing = standings.get(r.id);
      if (!standing) return [];
      const fact: CompletionFacts = {
        key: requirementKey(r.seq),
        title: r.title,
        status: r.status,
        state: standing.state as RequirementState,
        coverage: standing.coverage,
        live: live
          .filter((i) => i.requirementId === r.id)
          .map((i) => ({ id: i.id, key: formatIssueRef(prefix, i.seq), status: i.status })),
      };
      return [[r.id, fact] as const];
    }),
  );
}

async function cuttersOf(runIds: readonly string[]): Promise<Map<string, ReleasePerson>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ runId: jobs.pipelineRunId, createdBy: jobs.createdBy })
    .from(jobs)
    .where(and(inArray(jobs.pipelineRunId, [...runIds]), eq(jobs.type, 'release_batch')))
    .orderBy(asc(jobs.queuedAt));
  const people = await peopleOf(rows.map((r) => r.createdBy));
  const out = new Map<string, ReleasePerson>();
  for (const r of rows) {
    const p = people.get(r.createdBy);
    if (p && !out.has(r.runId)) out.set(r.runId, { id: r.createdBy, ...p });
  }
  return out;
}

export async function loadReleaseFacts(
  projectId: string,
  issueIds: readonly string[],
  runIds: readonly string[],
): Promise<ReleaseFacts> {
  const ids = [...new Set(issueIds)];
  const [rows, prefix, cutters] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: issues.id,
            seq: issues.issSeq,
            title: issues.title,
            status: issues.status,
            updatedAt: issues.updatedAt,
            releaseNotes: issues.releaseNotes,
            requirementId: issues.requirementId,
          })
          .from(issues)
          .where(and(eq(issues.projectId, projectId), inArray(issues.id, ids))),
    activeIssuePrefix(projectId),
    cuttersOf(runIds),
  ]);
  const [criteria, reopened, reqs] = await Promise.all([
    listCriteriaOf(db, ids),
    reopenedAtOf(db, ids),
    requirementFacts(
      projectId,
      rows.flatMap((r) => (r.requirementId ? [r.requirementId] : [])),
    ),
  ]);
  const byIssue = new Map<string, IssueFact>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        key: r.seq != null ? formatIssueRef(prefix, r.seq) : r.id,
        title: r.title ?? '(untitled)',
        status: r.status,
        updatedAt: r.updatedAt,
        releaseNotes: r.releaseNotes ?? null,
        requirementId: r.requirementId,
        criteria: (criteria.get(r.id) ?? []).map((c) => criterionView(c, reopened.get(r.id))),
      },
    ]),
  );
  for (const req of reqs.values()) {
    for (const bc of req.coverage) {
      for (const link of bc.issues) {
        const view = byIssue.get(link.issueId)?.criteria.find((c) => c.n === link.criterion);
        if (view && !link.stale) view.bc = bc.code;
      }
    }
  }
  return { issues: byIssue, requirements: reqs, cutters };
}

export async function approversOf(projectId: string): Promise<ReleasePerson[]> {
  const [project] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return [];
  const [direct, org] = await Promise.all([
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, 'admin'))),
    db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, project.orgId),
          inArray(organizationMembers.role, ['admin', 'owner']),
        ),
      ),
  ]);
  const ids = [...new Set([...direct, ...org].map((r) => r.userId))];
  const people = await peopleOf(ids);
  return ids.flatMap((id) => {
    const p = people.get(id);
    return p ? [{ id, ...p }] : [];
  });
}
