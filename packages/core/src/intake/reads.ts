/**
 * Everything the intake assistant reads for a draft (REQ-34 BC-11): the item it drafts, and the
 * project's requirements, workflow designs, feedback and releases. Nothing else: no issue, no
 * comment, no code, no knowledge entry. `reads.test.ts` holds this file and the drafter to that, by
 * what they import and by what a draft calls.
 *
 * Each record is shown to the model under a ref (REQ-n, FB-n, workflow:<flow>, release:<version>),
 * which is how a link or an assumption's source names it back. A requirement or feedback item with a
 * stored vector puts its nearest records first (feedback-triage r16 `dedup`); one not embedded yet
 * reads them by recency.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import {
  type IntakeItemKind,
  type IntakeRefKind,
  intakeRefOf,
} from '@forge/contracts/intake-drafts';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { releaseHighlights } from '../db/schema-release-highlights.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { itemEmbeddingOf, nearestItems } from '../knowledge/index.js';

const REQUIREMENTS_MAX = 60;
const FEEDBACK_MAX = 40;
const WORKFLOWS_MAX = 40;
const RELEASES_MAX = 8;
const CRITERIA_MAX = 12;
const NEAREST = 8;
const LINE_MAX = 400;

const clip = (text: string, max = LINE_MAX) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The item being drafted, as the model reads it. */
export interface IntakeItem {
  kind: IntakeItemKind;
  id: string;
  projectId: string;
  /** REQ-n or FB-n: also the ref an assumption names for the item's own words. */
  key: string;
  title: string;
  lines: string[];
  authorId: string;
  authorAgency: ActorAgency;
}

/** One record of the four reads, as the model reads it and a link names it. */
export interface IntakeRecord {
  ref: string;
  kind: IntakeRefKind;
  key: string;
  title: string;
  lines: string[];
}

/** Whether a feedback item's own text may be shown, or only its key, kind and status (no_egress). */
export interface FeedbackReadOptions {
  withText: boolean;
}

export interface IntakeReads {
  item(kind: IntakeItemKind, id: string): Promise<IntakeItem | null>;
  requirements(item: IntakeItem): Promise<IntakeRecord[]>;
  workflows(item: IntakeItem): Promise<IntakeRecord[]>;
  feedback(item: IntakeItem, opts: FeedbackReadOptions): Promise<IntakeRecord[]>;
  releases(item: IntakeItem): Promise<IntakeRecord[]>;
}

const workflowRef = (flow: string) => intakeRefOf({ kind: 'workflow', key: flow });
const releaseRef = (version: string) => intakeRefOf({ kind: 'release', key: version });

async function requirementItem(id: string): Promise<IntakeItem | null> {
  const [req] = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
    })
    .from(requirements)
    .where(eq(requirements.id, id))
    .limit(1);
  if (!req) return null;
  const [rev] = await db
    .select({
      tldr: requirementRevisions.tldr,
      spec: requirementRevisions.spec,
      authorId: requirementRevisions.authorId,
      authorAgency: requirementRevisions.authorAgency,
    })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, id))
    .orderBy(desc(requirementRevisions.revision))
    .limit(1);
  if (!rev) return null;
  const spec = (rev.spec ?? {}) as {
    goal?: string;
    personas?: string[];
    scopeIn?: string[];
    scopeOut?: string[];
  };
  const criteria = await db
    .select({ code: requirementCriteria.code, body: requirementCriteria.body })
    .from(requirementCriteria)
    .where(
      and(eq(requirementCriteria.requirementId, id), isNull(requirementCriteria.retiredRevision)),
    )
    .orderBy(requirementCriteria.createdAt)
    .limit(CRITERIA_MAX);
  const key = requirementKey(req.reqSeq);
  const lines = [`Title: ${req.title}`];
  if (rev.tldr?.trim()) lines.push(`Summary: ${clip(oneLine(rev.tldr))}`);
  if (spec.goal?.trim()) lines.push(`Goal: ${clip(oneLine(spec.goal))}`);
  if (spec.personas?.length) lines.push(`Personas: ${clip(spec.personas.join('; '))}`);
  if (spec.scopeIn?.length) lines.push(`In scope: ${clip(spec.scopeIn.join('; '))}`);
  if (spec.scopeOut?.length) lines.push(`Out of scope: ${clip(spec.scopeOut.join('; '))}`);
  for (const c of criteria) lines.push(`${c.code}: ${clip(oneLine(c.body), 200)}`);
  return {
    kind: 'requirement',
    id: req.id,
    projectId: req.projectId,
    key,
    title: req.title,
    lines,
    authorId: rev.authorId,
    authorAgency: rev.authorAgency === 'agent' ? 'agent' : 'human',
  };
}

/** What a feedback item is about, named by the four reads only; an issue target is named, never read. */
async function aboutOf(row: typeof feedback.$inferSelect): Promise<string> {
  if (row.requirementId) {
    const [r] = await db
      .select({ seq: requirements.reqSeq })
      .from(requirements)
      .where(eq(requirements.id, row.requirementId))
      .limit(1);
    return r ? requirementKey(r.seq) : 'a requirement';
  }
  if (row.workflowId) {
    const [w] = await db
      .select({ flow: projectWorkflows.flow })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, row.workflowId))
      .limit(1);
    const node = row.stepId
      ? ` step ${row.stepId}`
      : row.edgeFrom
        ? ` edge ${row.edgeFrom}->${row.edgeTo}`
        : '';
    return w ? `${workflowRef(w.flow)}${node}` : 'a workflow';
  }
  if (row.releaseRunId) {
    const [h] = await db
      .select({ version: releaseHighlights.version })
      .from(releaseHighlights)
      .where(eq(releaseHighlights.runId, row.releaseRunId))
      .limit(1);
    return h ? releaseRef(h.version) : 'a release';
  }
  if (row.issueId) return 'an issue (not read)';
  if (row.contractSlug) return `contract ${row.contractSlug} ${row.contractVersion ?? ''}`.trim();
  if (row.endpointElement) return `${row.endpointContractSlug} ${row.endpointElement}`;
  return row.whereSeen ? `the screen ${row.whereSeen}` : 'nothing named';
}

async function feedbackItem(id: string): Promise<IntakeItem | null> {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
  if (!row) return null;
  const lines = [
    `Title: ${row.title}`,
    `Kind given: ${row.kind}; severity given: ${row.severity}`,
    `About: ${await aboutOf(row)}`,
  ];
  if (row.body?.trim()) lines.push(`Body: ${clip(oneLine(row.body), 1500)}`);
  if (row.whereSeen?.trim()) lines.push(`Where seen: ${clip(oneLine(row.whereSeen), 200)}`);
  return {
    kind: 'feedback',
    id: row.id,
    projectId: row.projectId,
    key: feedbackKey(row.fbSeq),
    title: row.title,
    lines,
    authorId: row.reportedBy,
    authorAgency: row.reporterAgency,
  };
}

/** The item's stored vector, where it has one: the nearest records of `kind` lead their list. */
async function nearestOf(item: IntakeItem, kind: 'requirement' | 'feedback'): Promise<string[]> {
  const own = await itemEmbeddingOf(
    item.kind === 'requirement' ? { requirementId: item.id } : { feedbackId: item.id },
  );
  if (own?.status !== 'embedded' || !own.embedding || !own.model) return [];
  const near = await nearestItems({
    projectId: item.projectId,
    kind,
    vector: own.embedding,
    model: own.model,
    exclude: item.id,
    limit: NEAREST,
  });
  return near.map((n) => n.itemId);
}

const nearestFirst = <T extends { id: string }>(rows: T[], near: readonly string[]): T[] => {
  const rank = new Map(near.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
};

async function requirementRecords(item: IntakeItem): Promise<IntakeRecord[]> {
  const near = await nearestOf(item, 'requirement');
  const rows = await db
    .select({
      id: requirements.id,
      seq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
    })
    .from(requirements)
    .where(
      and(
        eq(requirements.projectId, item.projectId),
        ne(requirements.status, 'dropped'),
        item.kind === 'requirement' ? ne(requirements.id, item.id) : undefined,
      ),
    )
    .orderBy(desc(requirements.updatedAt))
    .limit(REQUIREMENTS_MAX);
  const ordered = nearestFirst(rows, near);
  const ids = ordered.map((r) => r.id);
  const [heads, criteria] = ids.length
    ? await Promise.all([
        db
          .selectDistinctOn([requirementRevisions.requirementId], {
            requirementId: requirementRevisions.requirementId,
            tldr: requirementRevisions.tldr,
          })
          .from(requirementRevisions)
          .where(inArray(requirementRevisions.requirementId, ids))
          .orderBy(requirementRevisions.requirementId, desc(requirementRevisions.revision)),
        db
          .select({
            requirementId: requirementCriteria.requirementId,
            code: requirementCriteria.code,
            body: requirementCriteria.body,
          })
          .from(requirementCriteria)
          .where(
            and(
              inArray(requirementCriteria.requirementId, ids),
              isNull(requirementCriteria.retiredRevision),
            ),
          )
          .orderBy(requirementCriteria.createdAt),
      ])
    : [[], []];
  const tldrOf = new Map(heads.map((h) => [h.requirementId, h.tldr]));
  return ordered.map((r) => {
    const key = requirementKey(r.seq);
    const lines = [`${key} (${r.status}): ${r.title}`];
    const tldr = tldrOf.get(r.id);
    if (tldr?.trim()) lines.push(`  In short: ${clip(oneLine(tldr), 240)}`);
    for (const c of criteria.filter((c) => c.requirementId === r.id).slice(0, CRITERIA_MAX)) {
      lines.push(`  ${c.code}: ${clip(oneLine(c.body), 160)}`);
    }
    return { ref: key, kind: 'requirement', key, title: r.title, lines };
  });
}

interface DesignDocument {
  title?: string;
  summary?: string;
  steps?: { id?: string; node?: { label?: string } }[];
  states?: { id?: string; node?: { label?: string } }[];
}

async function workflowRecords(item: IntakeItem): Promise<IntakeRecord[]> {
  const rows = await db
    .select({
      flow: projectWorkflows.flow,
      document: projectWorkflows.document,
      designStatus: projectWorkflows.designStatus,
      approvedRevision: projectWorkflows.approvedRevision,
    })
    .from(projectWorkflows)
    .where(eq(projectWorkflows.projectId, item.projectId))
    .orderBy(desc(projectWorkflows.updatedAt))
    .limit(WORKFLOWS_MAX);
  return rows.map((w) => {
    const doc = (w.document ?? {}) as DesignDocument;
    const title = doc.title ?? w.flow;
    const status = w.approvedRevision
      ? `approved r${w.approvedRevision}`
      : (w.designStatus ?? 'no design');
    const lines = [`${workflowRef(w.flow)} (${title}, ${status})`];
    if (doc.summary?.trim()) lines.push(`  ${clip(oneLine(doc.summary), 300)}`);
    const nodes = [...(doc.steps ?? []), ...(doc.states ?? [])]
      .map((s) => s.node?.label ?? s.id)
      .filter((l): l is string => typeof l === 'string' && l.trim() !== '');
    if (nodes.length) lines.push(`  Steps: ${clip(nodes.join('; '), 400)}`);
    return { ref: workflowRef(w.flow), kind: 'workflow', key: w.flow, title, lines };
  });
}

async function feedbackRecords(
  item: IntakeItem,
  opts: FeedbackReadOptions,
): Promise<IntakeRecord[]> {
  const near = await nearestOf(item, 'feedback');
  const rows = await db
    .select({
      id: feedback.id,
      seq: feedback.fbSeq,
      title: feedback.title,
      body: feedback.body,
      kind: feedback.kind,
      severity: feedback.severity,
      status: feedback.status,
    })
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, item.projectId),
        item.kind === 'feedback' ? ne(feedback.id, item.id) : undefined,
      ),
    )
    .orderBy(desc(feedback.createdAt))
    .limit(FEEDBACK_MAX);
  return nearestFirst(rows, near).map((f) => {
    const key = feedbackKey(f.seq);
    const head = `${key} (${f.kind}, ${f.severity}, ${f.status})`;
    if (!opts.withText) return { ref: key, kind: 'feedback', key, title: key, lines: [head] };
    const lines = [`${head}: ${clip(oneLine(f.title), 200)}`];
    if (f.body?.trim()) lines.push(`  ${clip(oneLine(f.body), 300)}`);
    return { ref: key, kind: 'feedback', key, title: f.title, lines };
  });
}

interface Highlight {
  title?: unknown;
  body?: unknown;
  requirement?: { key?: unknown };
}

async function releaseRecords(item: IntakeItem): Promise<IntakeRecord[]> {
  const rows = await db
    .select({ version: releaseHighlights.version, highlights: releaseHighlights.highlights })
    .from(releaseHighlights)
    .where(
      and(eq(releaseHighlights.projectId, item.projectId), eq(releaseHighlights.state, 'drafted')),
    )
    .orderBy(desc(releaseHighlights.createdAt))
    .limit(RELEASES_MAX);
  return rows.map((r) => {
    const said = Array.isArray(r.highlights)
      ? (r.highlights as Highlight[]).flatMap((h) =>
          typeof h.title === 'string'
            ? [
                `${h.title}${typeof h.requirement?.key === 'string' ? ` (${h.requirement.key})` : ''}${typeof h.body === 'string' ? `: ${oneLine(h.body)}` : ''}`,
              ]
            : [],
        )
      : [];
    const lines = [`${releaseRef(r.version)}`];
    if (said.length) lines.push(`  Shipped: ${clip(said.join('; '), 400)}`);
    return { ref: releaseRef(r.version), kind: 'release', key: r.version, title: r.version, lines };
  });
}

/** The reads against the database. */
export const dbIntakeReads: IntakeReads = {
  item: (kind, id) => (kind === 'requirement' ? requirementItem(id) : feedbackItem(id)),
  requirements: requirementRecords,
  workflows: workflowRecords,
  feedback: feedbackRecords,
  releases: releaseRecords,
};
