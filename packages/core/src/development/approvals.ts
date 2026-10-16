/**
 * The approval inbox (`@forge/contracts/approvals`): every pending record of one project waiting on
 * the viewer's approve-type decision. A requirement revision, an agreement, a release and a design
 * come from the needs-me classification (`needs-you-decisions.ts:decisionsOf`), so a row here is the
 * same decision the home and the chat show, with the same buttons; suggestions, mockups and issue
 * previews come from their owners' reads, each kept only where the viewer may decide it. Who asked
 * is read from the record that asked, never guessed: a row whose record keeps nobody says so.
 */

import {
  APPROVAL_INBOX_MAX,
  type ApprovalAct,
  type ApprovalAsker,
  type ApprovalInbox,
  type ApprovalItem,
  type ApprovalReason,
  approvalInboxSchema,
  byWaitedLongest,
  REASONLESS_ACTS,
} from '@forge/contracts/approvals';
import {
  type DecisionAct,
  type DecisionAnswer,
  decisionPath,
} from '@forge/contracts/needs-you-decisions';
import type { SuggestionProducer } from '@forge/contracts/suggestions';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { projectWorkflowDesigns } from '../db/schema-workflows.js';
import type { ProjectAccess } from '../lib/authz.js';
import { type Person, peopleOf } from '../lib/people.js';
import { waitingMockupsAs } from '../mockups/read.js';
import { holds } from '../permissions/index.js';
import { approvablePreviewsOf } from '../previews/read.js';
import { waitingSuggestionsFor } from '../suggestions/waiting-read.js';
import { type NeedsYouViewer, owedOf, readAttention } from './needs-you.js';
import { decisionsOf, type OwedDecision } from './needs-you-decisions.js';
import { releaseApprovalsOfRuns } from './ports.js';

/** A moved base's pin-only dependents, cleared by one act on the base's page (`needs-you-design.ts:repinRowOf`). */
const REPIN = 'designs.act.repinBatch';

type Asker = { kind: ApprovalAsker; userId: string | null } | null;
type Pending = Omit<ApprovalItem, 'askedBy'> & { asker: Asker };

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

const personAsker = (userId: string, people: ReadonlyMap<string, Person>): Asker => ({
  kind: people.get(userId)?.kind === 'agent' ? 'agent' : 'person',
  userId,
});

const base = {
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

interface Ids {
  requirement: ReadonlyMap<string, string>;
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

/** The approve-group decisions the needs-me read builds for the viewer, as inbox rows. */
async function decidedRows(
  owed: readonly OwedDecision[],
  ids: Ids,
  releaseAsks: ReadonlyMap<string, { userId: string; at: string }>,
): Promise<Pending[]> {
  const proposers = await proposersOf(owed, ids);
  return owed.map((o): Pending => {
    const d = o.decision;
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
    const kind = approve.act === 'revision.accept' ? 'revision' : 'agreement';
    return {
      ...base,
      kind,
      revision: n,
      id: `${kind}:${reqId ?? d.key}:${n ?? 0}`,
      key: d.key,
      title: writersTitle(o),
      asker: proposed?.userId ? { kind: 'person', userId: proposed.userId } : null,
      since: (kind === 'revision' ? proposed?.at : null) ?? d.touchedAt,
      opens: { kind: 'requirement', key: d.key },
      approve,
      decline,
    };
  });
}

export async function readApprovals(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<ApprovalInbox> {
  const attention = await readAttention(projectId, viewer, now);
  const mayApprovePreviews = holds(access, 'previews.approve');
  const [{ owed }, suggestions, mockups, previews] = await Promise.all([
    decisionsOf(projectId, attention),
    waitingSuggestionsFor(projectId, (p) => holds(access, p)),
    waitingMockupsAs(projectId, { userId: viewer.userId, agency: viewer.agency }),
    mayApprovePreviews ? approvablePreviewsOf(projectId) : [],
  ]);
  const approvals = owed.filter((o) => o.decision.group === 'approve');
  const runOf = new Map(
    attention.releases.releases.flatMap((r) => (r.runId ? [[r.version, r.runId] as const] : [])),
  );
  const asks = await releaseApprovalsOfRuns(
    approvals.flatMap((o) =>
      o.decision.entity === 'release' && runOf.has(o.decision.key)
        ? [runOf.get(o.decision.key) as string]
        : [],
    ),
  );
  const versionOf = new Map([...runOf].map(([v, run]) => [run, v]));
  const releaseAsks = new Map(
    asks
      .filter((a) => a.decision === null)
      .flatMap((a) => {
        const v = versionOf.get(a.runId);
        return v
          ? [[v, { userId: a.requestedByUser, at: a.requestedAt.toISOString() }] as const]
          : [];
      }),
  );
  const ids: Ids = {
    requirement: new Map(attention.requirements.map((r) => [r.key, r.id])),
    design: new Map(
      [...attention.health.values()].flatMap((h) =>
        h.proposal
          ? [
              [
                h.flow,
                {
                  workflowId: h.workflowId,
                  revision: h.proposal.revision,
                  title: h.proposal.title,
                },
              ] as const,
            ]
          : [],
      ),
    ),
  };

  const pending: Pending[] = [
    ...(await decidedRows(approvals, ids, releaseAsks)),
    ...owedOf(attention.rows)
      .designs.filter(
        (r) => r.standing.waitingOn.says.act.key === REPIN && r.standing.waitingOn.kind === 'you',
      )
      .map(
        (r): Pending => ({
          ...base,
          kind: 'repin',
          id: `repin:${r.key}`,
          key: r.key,
          title: '',
          asker: null,
          since: r.touchedAt,
          opens: { kind: 'workflow', key: r.key },
          approve: null,
          decline: null,
        }),
      ),
    ...suggestions.map(
      (s): Pending => ({
        ...base,
        kind: 'suggestion',
        suggestionKind: s.kind,
        id: `suggestion:${s.id}`,
        key: s.target.key,
        title: s.title,
        asker: { kind: producerAsker(s.producerKind), userId: s.producerId },
        since: s.createdAt,
        opens: { kind: s.target.type, key: s.target.key },
        approve: s.mayAccept
          ? actFor('suggestion.accept', { projectId, suggestionId: s.id })
          : null,
        decline: s.mayReject
          ? actFor('suggestion.reject', { projectId, suggestionId: s.id }, true)
          : null,
      }),
    ),
    ...mockups.map(
      (m): Pending => ({
        ...base,
        kind: 'mockup',
        mockupKind: m.kind,
        id: `mockup:${m.id}`,
        key: m.key,
        title: m.caption ?? m.name,
        asker: { kind: m.proposedAgency === 'agent' ? 'agent' : 'person', userId: m.proposedBy },
        since: m.createdAt,
        opens: { kind: m.target.type, key: m.target.key },
        approve: actFor('mockup.accept', { projectId, mockupKey: m.key }),
        decline: m.can.return
          ? actFor('mockup.return', { projectId, mockupKey: m.key }, true)
          : null,
      }),
    ),
  ];
  const people = await peopleOf([
    ...pending.map((p) => p.asker?.userId ?? null),
    ...previews.map((p) => p.createdBy),
  ]);
  for (const p of previews) {
    pending.push({
      ...base,
      kind: 'preview',
      id: `preview:${p.id}`,
      key: p.issueKey,
      title: p.issueTitle,
      asker: personAsker(p.createdBy, people),
      since: p.since,
      opens: { kind: 'issue', key: p.issueKey },
      approve: actFor('preview.approve', { previewId: p.id }),
      decline: null,
    });
  }
  const items = pending
    .map(
      ({ asker, ...rest }): ApprovalItem => ({
        ...rest,
        askedBy: asker
          ? {
              kind:
                asker.kind === 'person' &&
                asker.userId &&
                people.get(asker.userId)?.kind === 'agent'
                  ? 'agent'
                  : asker.kind,
              name: asker.userId ? (people.get(asker.userId)?.name ?? null) : null,
            }
          : null,
      }),
    )
    .sort(byWaitedLongest);
  return approvalInboxSchema.parse({
    generatedAt: now.toISOString(),
    items: items.slice(0, APPROVAL_INBOX_MAX),
    total: items.length,
  });
}
