/**
 * The approval inbox's rows (`approvals.ts:readApprovals`), each built from the record it decides, or
 * the record named with what broke where no row can be made of it. Every row is checked against the
 * inbox's own row schema one at a time, so one record the schema cannot hold is listed as unreadable
 * and the rest of the inbox still answers.
 */

import {
  type ApprovalAct,
  type ApprovalAsker,
  type ApprovalItem,
  type ApprovalKind,
  type ApprovalReason,
  type ApprovalUnreadable,
  approvalItemSchema,
  approvalTitle,
  approvalUnreadableSchema,
  REASONLESS_ACTS,
} from '@forge/contracts/approvals';
import type { MockupView } from '@forge/contracts/mockups';
import {
  type DecisionAct,
  type DecisionAnswer,
  decisionPath,
} from '@forge/contracts/needs-you-decisions';
import type { SuggestionProducer } from '@forge/contracts/suggestions';
import { cutAtWord } from '@forge/contracts/title-text';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { projectWorkflowDesigns } from '../db/schema-workflows.js';
import { logger } from '../lib/logger.js';
import type { Person } from '../lib/people.js';
import type { ApprovablePreview } from '../previews/read.js';
import type { WaitingSuggestion } from '../suggestions/waiting-read.js';
import { problemOf } from './approvals-problem.js';
import type { OwedDecision } from './needs-you-decisions.js';

export type Asker = { kind: ApprovalAsker; userId: string | null } | null;
export type Pending = Omit<ApprovalItem, 'askedBy'> & { asker: Asker };

/** What a row is, known before it is built, so a row that cannot be built is still named. */
export type Ref = Pick<ApprovalUnreadable, 'kind' | 'id' | 'key' | 'opens'>;
export type Built = { ok: true; row: Pending } | { ok: false; ref: Ref; problem: string };

/** One row, or the record it was to be, named with what went wrong, never the whole inbox's 500. */
export function attempt(ref: Ref, build: () => Pending): Built {
  try {
    return { ok: true, row: build() };
  } catch (err) {
    return { ok: false, ref, problem: err instanceof Error ? err.message : String(err) };
  }
}

function filled(act: DecisionAct, params: Record<string, string | number | undefined>): string {
  const path = decisionPath(act, params);
  if (!path.ok) {
    throw new Error(
      `approvals: a ${act} act is missing ${path.missing.join(', ')}; an approval never posts to a path with a hole in it`,
    );
  }
  return path.path;
}

const reasonOf = (act: DecisionAct, required: boolean): ApprovalReason =>
  required ? 'required' : REASONLESS_ACTS.has(act) ? 'none' : 'optional';

const actOf = (a: DecisionAnswer): ApprovalAct => ({
  act: a.act,
  path: a.path,
  body: a.body,
  reason: reasonOf(a.act, a.needsReason),
});

const actFor = (
  act: DecisionAct,
  params: Record<string, string | number | undefined>,
  required = false,
): ApprovalAct => ({ act, path: filled(act, params), body: {}, reason: reasonOf(act, required) });

/** The two answers of an approve-group decision, by the ids its builder gives them. */
function answersOf(o: OwedDecision): { approve: ApprovalAct; decline: ApprovalAct } {
  const pick = (ids: readonly string[]) => {
    const a = o.decision.answers.find((x) => ids.includes(x.id));
    if (!a) {
      throw new Error(
        `approvals: the ${o.decision.entity} decision on ${o.decision.key} offers none of ${ids.join(', ')}`,
      );
    }
    return actOf(a);
  };
  return { approve: pick(['accept', 'agree', 'approve']), decline: pick(['return', 'drop']) };
}

const producerAsker = (kind: SuggestionProducer): ApprovalAsker =>
  kind === 'ba_assistant' ? 'assistant' : kind === 'agent' ? 'agent' : 'person';

export const personAsker = (userId: string, people: ReadonlyMap<string, Person>): Asker => ({
  kind: people.get(userId)?.kind === 'agent' ? 'agent' : 'person',
  userId,
});

export const base = {
  suggestionKind: null,
  mockupKind: null,
  revision: null,
} as const;

/** Who proposed each requirement revision and design revision the decisions name, in two reads. */
async function proposersOf(owed: readonly OwedDecision[], ids: Ids) {
  const revs = owed.flatMap((o) => {
    const reqId = ids.requirement.get(o.decision.key);
    const n = revisionOf(o);
    return o.decision.entity === 'requirement' && reqId && n ? [{ reqId, n }] : [];
  });
  const designs = owed.flatMap((o) => {
    const d = ids.design.get(o.decision.key);
    return o.decision.entity === 'workflow' && d ? [d] : [];
  });
  const [revRows, designRows] = await Promise.all([
    revs.length
      ? db
          .select({
            requirementId: requirementRevisions.requirementId,
            revision: requirementRevisions.revision,
            proposedBy: requirementRevisions.proposedBy,
            authorId: requirementRevisions.authorId,
            proposedAt: requirementRevisions.proposedAt,
          })
          .from(requirementRevisions)
          .where(
            or(
              ...revs.map((r) =>
                and(
                  eq(requirementRevisions.requirementId, r.reqId),
                  eq(requirementRevisions.revision, r.n),
                ),
              ),
            ),
          )
      : [],
    designs.length
      ? db
          .select({
            workflowId: projectWorkflowDesigns.workflowId,
            revision: projectWorkflowDesigns.revision,
            proposedBy: projectWorkflowDesigns.proposedByUser,
            proposedAt: projectWorkflowDesigns.proposedAt,
          })
          .from(projectWorkflowDesigns)
          .where(
            inArray(
              projectWorkflowDesigns.workflowId,
              designs.map((d) => d.workflowId),
            ),
          )
      : [],
  ]);
  return {
    revision: new Map(
      revRows.map((r) => [
        `${r.requirementId}:${r.revision}`,
        { userId: r.proposedBy ?? r.authorId, at: r.proposedAt?.toISOString() ?? null },
      ]),
    ),
    design: new Map(
      designRows.map((d) => [
        `${d.workflowId}:${d.revision}`,
        { userId: d.proposedBy, at: d.proposedAt.toISOString() },
      ]),
    ),
  };
}

export interface Ids {
  requirement: ReadonlyMap<string, string>;
  /** A requirement's short title by its key: its short name, else its title. */
  requirementTitle: ReadonlyMap<string, string>;
  design: ReadonlyMap<string, { workflowId: string; revision: number; title: string }>;
}

/** The revision a requirement decision decides, from what its approve button posts. */
function revisionOf(o: OwedDecision): number | null {
  const { approve } = answersOf(o);
  const revision = approve.body?.revision;
  if (typeof revision === 'number') return revision;
  // a revision's accept names it in its path, `/revisions/:n/accept`
  const n = /\/revisions\/(\d+)\/accept$/.exec(approve.path)?.[1];
  return n ? Number(n) : null;
}

/** The row's title where its writer wrote it; empty where Forge composed one, which the page words itself. */
const writersTitle = (o: OwedDecision): string =>
  o.row.says.title.key === 'standing.text' ? o.decision.title : '';

/** The page an approve-group decision's row opens, by the entity it decides. */
const OPENS_OF: Partial<Record<string, 'release' | 'workflow' | 'requirement'>> = {
  release: 'release',
  workflow: 'workflow',
  requirement: 'requirement',
};

/** The kind a decision's row is, read without building it. */
function decidedKind(o: OwedDecision): ApprovalKind {
  if (o.decision.entity === 'release') return 'release';
  if (o.decision.entity === 'workflow') return 'design';
  return o.decision.answers.some((a) => a.act === 'revision.accept') ? 'revision' : 'agreement';
}

/** The approve-group decisions the needs-me read builds for the viewer, as inbox rows. */
export async function decidedRows(
  owed: readonly OwedDecision[],
  ids: Ids,
  releaseAsks: ReadonlyMap<string, { userId: string; at: string }>,
): Promise<Built[]> {
  const proposers = await proposersOf(owed, ids);
  return owed.map((o): Built => {
    const d = o.decision;
    const kind = decidedKind(o);
    const opens = { kind: OPENS_OF[d.entity] ?? 'requirement', key: d.key };
    const ref: Ref = { kind, id: `${kind}:${d.key}`, key: d.key, opens };
    return attempt(ref, (): Pending => {
      const { approve, decline } = answersOf(o);
      const n = revisionOf(o);
      if (d.entity === 'release') {
        const asked = releaseAsks.get(d.key);
        return {
          ...base,
          kind: 'release',
          id: `release:${d.key}`,
          key: d.key,
          title: writersTitle(o),
          asker: asked ? { kind: 'person', userId: asked.userId } : null,
          since: asked?.at ?? d.touchedAt,
          opens: { kind: 'release', key: d.key },
          approve,
          decline,
        };
      }
      if (d.entity === 'workflow') {
        const design = ids.design.get(d.key);
        if (!design) throw new Error(`approvals: design ${d.key} is decided with no proposal read`);
        const proposed = proposers.design.get(`${design.workflowId}:${design.revision}`);
        return {
          ...base,
          kind: 'design',
          revision: design.revision,
          id: `design:${design.workflowId}`,
          key: d.key,
          title: design.title,
          asker: proposed ? { kind: 'person', userId: proposed.userId } : null,
          since: proposed?.at ?? d.touchedAt,
          opens: { kind: 'workflow', key: d.key },
          approve,
          decline,
        };
      }
      const reqId = ids.requirement.get(d.key);
      const proposed = reqId && n ? proposers.revision.get(`${reqId}:${n}`) : undefined;
      const title = ids.requirementTitle.get(d.key);
      if (title === undefined) {
        throw new Error(`approvals: requirement ${d.key} is decided with no requirement read`);
      }
      return {
        ...base,
        kind,
        revision: n,
        id: `${kind}:${reqId ?? d.key}:${n ?? 0}`,
        key: d.key,
        title,
        asker: proposed?.userId ? { kind: 'person', userId: proposed.userId } : null,
        since: (kind === 'revision' ? proposed?.at : null) ?? d.touchedAt,
        opens: { kind: 'requirement', key: d.key },
        approve,
        decline,
      };
    });
  });
}

/** A record no row could be made of, as the inbox names it: never itself the reason the read fails. */
function unreadableOf(ref: Ref, problem: string): ApprovalUnreadable {
  const opens = approvalUnreadableSchema.shape.opens.safeParse(ref.opens);
  return approvalUnreadableSchema.parse({
    kind: ref.kind,
    id: cutAtWord(ref.id, 300),
    key: cutAtWord(ref.key || ref.id, 200),
    opens: opens.success ? opens.data : null,
    problem: cutAtWord(problem || 'the row could not be built', 1000),
  });
}

/** Each waiting suggestion as a row, titled by the record it is on. */
export const suggestionRows = (
  projectId: string,
  suggestions: readonly WaitingSuggestion[],
): Built[] =>
  suggestions.map((s) => {
    const opens = { kind: s.target.type, key: s.target.key };
    const ref: Ref = { kind: 'suggestion', id: `suggestion:${s.id}`, key: s.target.key, opens };
    return attempt(
      ref,
      (): Pending => ({
        ...base,
        kind: 'suggestion',
        suggestionKind: s.kind,
        id: ref.id,
        key: s.target.key,
        title: s.target.title,
        asker: { kind: producerAsker(s.producerKind), userId: s.producerId },
        since: s.createdAt,
        opens,
        approve: s.mayAccept
          ? actFor('suggestion.accept', { projectId, suggestionId: s.id })
          : null,
        decline: s.mayReject
          ? actFor('suggestion.reject', { projectId, suggestionId: s.id }, true)
          : null,
      }),
    );
  });

/** Each waiting mockup as a row, titled by its name, never its caption. */
export const mockupRows = (projectId: string, mockups: readonly MockupView[]): Built[] =>
  mockups.map((m) => {
    const opens = { kind: m.target.type, key: m.target.key };
    const ref: Ref = { kind: 'mockup', id: `mockup:${m.id}`, key: m.key, opens };
    return attempt(
      ref,
      (): Pending => ({
        ...base,
        kind: 'mockup',
        mockupKind: m.kind,
        id: ref.id,
        key: m.key,
        title: m.name,
        asker: { kind: m.proposedAgency === 'agent' ? 'agent' : 'person', userId: m.proposedBy },
        since: m.createdAt,
        opens,
        mockup: {
          url: m.url,
          round: m.round,
          revises: m.revises,
          openComments: m.comments.open,
          consequence:
            m.target.type === 'requirement'
              ? 'pinned_next_baseline'
              : m.target.type === 'issue'
                ? 'given_to_issue_jobs'
                : 'kept_on_feedback',
        },
        approve: actFor('mockup.accept', { projectId, mockupKey: m.key }),
        decline: m.can.return
          ? actFor('mockup.return', { projectId, mockupKey: m.key }, true)
          : null,
      }),
    );
  });

/** Each live preview the viewer may approve as a row, titled by the issue it serves. */
export const previewRows = (
  previews: readonly ApprovablePreview[],
  people: ReadonlyMap<string, Person>,
): Built[] =>
  previews.map((p) => {
    const opens = { kind: 'issue', key: p.issueKey } as const;
    const ref: Ref = { kind: 'preview', id: `preview:${p.id}`, key: p.issueKey, opens };
    return attempt(ref, () => ({
      ...base,
      kind: 'preview',
      id: ref.id,
      key: p.issueKey,
      title: p.issueTitle,
      asker: personAsker(p.createdBy, people),
      since: p.since,
      opens,
      approve: actFor('preview.approve', { previewId: p.id }),
      decline: null,
    }));
  });

/**
 * The rows as the inbox carries them: each checked against the row schema on its own, a title cut to
 * the row's bound, and one the schema cannot hold named as unreadable, never the whole read's failure.
 */
export function inboxRowsOf(
  projectId: string,
  built: readonly Built[],
  people: ReadonlyMap<string, Person>,
): { items: ApprovalItem[]; unreadable: ApprovalUnreadable[] } {
  const items: ApprovalItem[] = [];
  const unreadable: ApprovalUnreadable[] = [];
  for (const b of built) {
    if (!b.ok) {
      unreadable.push(unreadableOf(b.ref, b.problem));
      continue;
    }
    const { asker, ...rest } = b.row;
    const row = approvalItemSchema.safeParse({
      ...rest,
      title: approvalTitle(rest.title),
      askedBy: asker
        ? {
            kind:
              asker.kind === 'person' && asker.userId && people.get(asker.userId)?.kind === 'agent'
                ? 'agent'
                : asker.kind,
            name: asker.userId ? (people.get(asker.userId)?.name ?? null) : null,
          }
        : null,
    });
    if (row.success) items.push(row.data);
    else unreadable.push(unreadableOf(b.row, problemOf(row.error.issues)));
  }
  if (unreadable.length) {
    // a silence is ours: the reader sees each by name, and the log says what broke
    logger.warn(
      { projectId, unreadable: unreadable.map((u) => ({ id: u.id, problem: u.problem })) },
      `approvals: ${unreadable.length} pending record(s) could not be made rows`,
    );
  }
  return { items, unreadable };
}
