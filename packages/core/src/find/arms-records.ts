// The keyword arms over the records a key or a title names (ISS-1256): issues, requirements, feedback,
// decisions and reference sources. Each matches every phrase of the expanded query as a substring of
// its title and text, or its key exactly, most recently changed first. The issue arm's predicate is
// `issues/search-predicate.ts`; the issue list's text filter is this door's issue filter
// (`issue-filter.ts`), so an issue is listed for words exactly where it is found for them.

import { and, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, projects, referenceSources } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { buildIlikePattern, buildIssueSearchCondition, issueDisplayIds } from '../issues/index.js';
import { type Candidate, hitId } from './candidate.js';

/** `ISS-12`, `REQ-3`, `FB-4`: a key's prefix and number. */
const KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

export const keyOf = (query: string): { prefix: string; seq: number } | null => {
  const m = KEY.exec(query.trim());
  return m?.[1] && m[2] ? { prefix: m[1].toUpperCase(), seq: Number(m[2]) } : null;
};

const anyOf = (conditions: SQL[]): SQL => or(...conditions) ?? sql`false`;

const keyword = (c: Omit<Candidate, 'arm' | 'id'>): Candidate => ({
  ...c,
  id: hitId(c.type, c.ref),
  arm: 'keyword',
});

/** Issues whose title, description, plan or criteria hold a phrase, or whose key is the query. */
export async function issueArm(
  projectIds: readonly string[],
  query: string,
  phrases: readonly string[],
  limit: number,
): Promise<Candidate[]> {
  const key = keyOf(query);
  const rows = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      releaseBatchRunId: issues.releaseBatchRunId,
    })
    .from(issues)
    .where(
      and(
        inArray(issues.projectId, [...projectIds]),
        anyOf([
          ...phrases.map((p) => buildIssueSearchCondition(p)),
          ...(key ? [eq(issues.issSeq, key.seq)] : []),
        ]),
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(limit);
  return hydrateIssues(rows, query);
}

type IssueRow = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  releaseBatchRunId: string | null;
};

/** What an issue hit carries for a filter that shows where the issue stands. */
export interface IssueNative {
  releaseBatchRunId: string | null;
}

/** Issue rows as candidates, keyed as the project shows them; a key query keeps only its own issue. */
export async function hydrateIssues(
  rows: readonly IssueRow[],
  query: string,
): Promise<Candidate[]> {
  const keys = await issueDisplayIds(rows.map((r) => r.id));
  const key = keyOf(query);
  const asked = query.trim().toUpperCase();
  return (
    rows
      // a key matches its own issue, never another project's issue of the same number
      .filter((r) => !key || keys.get(r.id)?.toUpperCase() === asked || phraseIn(r, query))
      .map((r) =>
        keyword({
          type: 'issue',
          ref: r.id,
          key: keys.get(r.id) ?? null,
          title: r.title,
          text: r.description ?? '',
          projectId: r.projectId,
          status: r.status,
          placed: { kind: 'issue', id: r.id },
          score: 0,
          native: { releaseBatchRunId: r.releaseBatchRunId } satisfies IssueNative,
        }),
      )
  );
}

const phraseIn = (r: { title: string; description: string | null }, query: string) =>
  `${r.title} ${r.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());

/** Requirements whose title holds a phrase, or whose key is the query. */
export async function requirementArm(
  projectIds: readonly string[],
  query: string,
  phrases: readonly string[],
  limit: number,
): Promise<Candidate[]> {
  const key = keyOf(query);
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      seq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
    })
    .from(requirements)
    .where(
      and(
        inArray(requirements.projectId, [...projectIds]),
        anyOf([
          ...phrases.map((p) => ilike(requirements.title, buildIlikePattern(p))),
          ...(key?.prefix === 'REQ' ? [eq(requirements.reqSeq, key.seq)] : []),
        ]),
      ),
    )
    .orderBy(desc(requirements.updatedAt))
    .limit(limit);
  return rows.map((r) => requirementCandidate(r, 'keyword'));
}

export const requirementCandidate = (
  r: { id: string; projectId: string; seq: number; title: string; status: string },
  arm: Candidate['arm'],
): Candidate => ({
  id: hitId('requirement', r.id),
  type: 'requirement',
  ref: r.id,
  key: `REQ-${r.seq}`,
  title: r.title,
  text: '',
  projectId: r.projectId,
  status: r.status,
  placed: { kind: 'requirement', id: r.id },
  score: 0,
  arm,
});

/** Feedback items whose title or body holds a phrase, or whose key is the query. */
export async function feedbackArm(
  projectIds: readonly string[],
  query: string,
  phrases: readonly string[],
  limit: number,
): Promise<Candidate[]> {
  const key = keyOf(query);
  const rows = await db
    .select(FEEDBACK_COLUMNS)
    .from(feedback)
    .where(
      and(
        inArray(feedback.projectId, [...projectIds]),
        anyOf([
          ...phrases.flatMap((p) => [
            ilike(feedback.title, buildIlikePattern(p)),
            ilike(feedback.body, buildIlikePattern(p)),
          ]),
          ...(key?.prefix === 'FB' ? [eq(feedback.fbSeq, key.seq)] : []),
        ]),
      ),
    )
    .orderBy(desc(feedback.updatedAt))
    .limit(limit);
  return rows.map((r) => feedbackCandidate(r, 'keyword'));
}

export const FEEDBACK_COLUMNS = {
  id: feedback.id,
  projectId: feedback.projectId,
  seq: feedback.fbSeq,
  title: feedback.title,
  body: feedback.body,
  status: feedback.status,
};

export const feedbackCandidate = (
  r: {
    id: string;
    projectId: string;
    seq: number;
    title: string;
    body: string | null;
    status: string;
  },
  arm: Candidate['arm'],
): Candidate => ({
  id: hitId('feedback', r.id),
  type: 'feedback',
  ref: r.id,
  key: `FB-${r.seq}`,
  title: r.title,
  text: r.body ?? '',
  projectId: r.projectId,
  status: r.status,
  placed: null,
  score: 0,
  arm,
});

/** The project a comment's target belongs to: its issue's, requirement's or feedback item's. */
const commentProject = sql<string>`COALESCE(
  (SELECT i.project_id FROM issues i WHERE i.id = ${comments.issueId}),
  (SELECT r.project_id FROM requirements r WHERE r.id = ${comments.requirementId}),
  (SELECT f.project_id FROM feedback f WHERE f.id = ${comments.feedbackId}),
  (SELECT w.project_id FROM project_workflows w WHERE w.id = ${comments.workflowId}))`;

/** Decisions recorded on an item whose decision, reason or text holds a phrase. */
export async function decisionArm(
  projectIds: readonly string[],
  phrases: readonly string[],
  limit: number,
): Promise<Candidate[]> {
  const text = sql<string>`coalesce(${comments.decision} ->> 'decision', '') || ' ' || coalesce(${comments.decision} ->> 'reason', '') || ' ' || ${comments.body}`;
  const rows = await db
    .select({
      id: comments.id,
      projectId: commentProject,
      decision: sql<string | null>`${comments.decision} ->> 'decision'`,
      text,
    })
    .from(comments)
    .where(
      and(
        eq(comments.intent, 'decision'),
        sql`${commentProject} = ANY(${sql`ARRAY[${sql.join(
          projectIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`})`,
        anyOf(phrases.map((p) => sql`${text} ILIKE ${buildIlikePattern(p)}`)),
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(limit);
  return rows.map((r) =>
    keyword({
      type: 'decision',
      ref: r.id,
      key: null,
      title: r.decision ?? r.text.slice(0, 120),
      text: r.text,
      projectId: r.projectId,
      status: null,
      placed: { kind: 'decision', id: r.id },
      score: 0,
    }),
  );
}

/** The project's reference sources and its org's, whose title, why or URL holds a phrase. */
export async function referenceArm(
  projectIds: readonly string[],
  phrases: readonly string[],
  limit: number,
): Promise<Candidate[]> {
  const orgs = db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]));
  const rows = await db
    .select({
      id: referenceSources.id,
      projectId: referenceSources.projectId,
      title: referenceSources.title,
      why: referenceSources.why,
      url: referenceSources.url,
      kind: referenceSources.kind,
    })
    .from(referenceSources)
    .where(
      and(
        isNull(referenceSources.removedAt),
        or(
          inArray(referenceSources.projectId, [...projectIds]),
          and(isNull(referenceSources.projectId), inArray(referenceSources.orgId, orgs)),
        ),
        anyOf(
          phrases.flatMap((p) => [
            ilike(referenceSources.title, buildIlikePattern(p)),
            ilike(referenceSources.why, buildIlikePattern(p)),
            ilike(referenceSources.url, buildIlikePattern(p)),
          ]),
        ),
      ),
    )
    .orderBy(desc(referenceSources.priority))
    .limit(limit);
  return rows.map((r) =>
    keyword({
      type: 'reference',
      ref: r.id,
      key: null,
      title: r.title,
      text: `${r.url} — ${r.why}`,
      projectId: r.projectId,
      status: r.kind,
      placed: { kind: 'reference', id: r.id },
      score: 0,
    }),
  );
}
