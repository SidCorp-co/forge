/**
 * A requirement delivered by another project's issue: a sibling project of the same organization
 * (adminhub-api's REQ-14 is half delivered by adminhub-fe's issues). The link is the issue's own
 * `requirement_id`, so every read of a requirement's issues already finds it; what changes is how
 * it is named. Two sibling projects usually share a prefix, so a bare `ISS-114` on the requirement
 * would read as the requirement project's own issue: one of another project is named
 * `<project-slug>/<key>` and carries that project.
 */

import { type OtherProject, requirementKey } from '@forge/contracts/requirements';
import { eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { formatIssueRef } from '../lib/issue-ref.js';

/** How the issues of a requirement in `projectId` are named: its own by its prefix, another project's by that project. */
export interface IssueNaming {
  projectId: string;
  prefix: string | null;
  others: ReadonlyMap<string, { project: OtherProject; prefix: string | null }>;
}

/** The naming of `linked`, read once: every project among them that is not `projectId`. */
export async function issueNamingOf(
  projectId: string,
  prefix: string | null,
  linked: readonly { projectId: string }[],
  ex: Pick<Tx, 'select'> = db,
): Promise<IssueNaming> {
  const ids = [...new Set(linked.map((i) => i.projectId))].filter((id) => id !== projectId);
  if (ids.length === 0) return { projectId, prefix, others: new Map() };
  const rows = await ex
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      prefix: projects.issuePrefix,
    })
    .from(projects)
    .where(inArray(projects.id, ids));
  return {
    projectId,
    prefix,
    others: new Map(
      rows.map((p) => [
        p.id,
        { project: { id: p.id, slug: p.slug, name: p.name }, prefix: p.prefix },
      ]),
    ),
  };
}

/** The issue as the requirement names it, and its project where that is another one. */
export function namedIssue(
  naming: IssueNaming,
  issue: { projectId: string; issSeq: number },
): { displayId: string; otherProject: OtherProject | null } {
  if (issue.projectId === naming.projectId) {
    return { displayId: formatIssueRef(naming.prefix, issue.issSeq), otherProject: null };
  }
  const other = naming.others.get(issue.projectId);
  // `issueNamingOf` reads every project its rows name, so a miss is a caller handing it other rows
  if (!other) {
    throw new Error(
      `requirements: issue of project ${issue.projectId} named without that project read (issueNamingOf)`,
    );
  }
  return {
    displayId: `${other.project.slug}/${formatIssueRef(other.prefix, issue.issSeq)}`,
    otherProject: other.project,
  };
}

/** Each project named, in the order named, with its org; undefined where none is held. */
export async function projectsOf(
  ids: readonly string[],
): Promise<({ id: string; slug: string; orgId: string } | undefined)[]> {
  const rows = await db
    .select({ id: projects.id, slug: projects.slug, orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, [...new Set(ids)]));
  return ids.map((id) => rows.find((p) => p.id === id));
}

/** A requirement of whichever project holds it: its key and that project. */
export async function requirementNamed(
  ex: Pick<Tx, 'select'>,
  requirementId: string,
): Promise<{ projectId: string; slug: string; key: string }> {
  const [r] = await ex
    .select({ projectId: requirements.projectId, slug: projects.slug, reqSeq: requirements.reqSeq })
    .from(requirements)
    .innerJoin(projects, eq(projects.id, requirements.projectId))
    .where(eq(requirements.id, requirementId));
  if (!r) throw new Error(`requirements: no requirement ${requirementId} to name`);
  return { projectId: r.projectId, slug: r.slug, key: requirementKey(r.reqSeq) };
}

/** The issues delivering each of `requirementIds`, of whichever project, in key order. */
export function linkedIssuesOf(requirementIds: readonly string[]) {
  return db
    .select({
      requirementId: issues.requirementId,
      id: issues.id,
      projectId: issues.projectId,
      issSeq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
      plan: issues.plan,
      plannedRevision: issues.plannedRevision,
    })
    .from(issues)
    .where(inArray(issues.requirementId, [...requirementIds]))
    .orderBy(issues.issSeq);
}
