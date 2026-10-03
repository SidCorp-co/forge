/**
 * Gathers the facts `standing.ts` derives from, for a page of requirements at once, and the
 * history a requirement's page reads: its revisions, agrees and suggestions, and the decisions,
 * questions and status moves recorded on its linked issues.
 */

import type { RequirementHistoryEntry, RequirementStanding } from '@forge/contracts/requirements';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, issues } from '../db/schema.js';
import {
  type DeliveryPhase,
  type RequirementStatus,
  type RevisionState,
  requirementBaselines,
  requirementCriteria,
  requirementDeferrals,
  requirementDelivery,
  requirementReturns,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { changedSincePlan } from './rules.js';
import { deriveStanding } from './standing.js';
import { issueCriteriaOf, latestPinsOf } from './standing-facts.js';

export interface StandingRow {
  id: string;
  projectId: string;
  status: string;
  currentRevision: number | null;
  ownerId: string | null;
  updatedAt: Date;
}

export interface StandingViewer {
  userId: string;
  canSignOff: boolean;
}

/** The standing of each requirement in `rows`, keyed by id; all rows belong to `projectId`. */
export async function standingsOf(
  projectId: string,
  rows: readonly StandingRow[],
  viewer: StandingViewer | null,
  now: Date = new Date(),
): Promise<Map<string, RequirementStanding>> {
  if (rows.length === 0) return new Map();
  const ids = rows.map((r) => r.id);
  const [revisions, criteria, delivery, linked, open, prefix, pins] = await Promise.all([
    db
      .select({
        requirementId: requirementRevisions.requirementId,
        revision: requirementRevisions.revision,
        state: requirementRevisions.state,
        authorId: requirementRevisions.authorId,
        createdAt: requirementRevisions.createdAt,
        proposedAt: requirementRevisions.proposedAt,
        decidedAt: requirementRevisions.decidedAt,
      })
      .from(requirementRevisions)
      .where(inArray(requirementRevisions.requirementId, ids))
      .orderBy(desc(requirementRevisions.revision)),
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
      .where(inArray(requirementCriteria.requirementId, ids)),
    db.select().from(requirementDelivery).where(inArray(requirementDelivery.requirementId, ids)),
    db
      .select({
        requirementId: issues.requirementId,
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        plan: issues.plan,
        plannedRevision: issues.plannedRevision,
      })
      .from(issues)
      .where(inArray(issues.requirementId, ids))
      .orderBy(issues.issSeq),
    db
      .select({ requirementId: suggestions.requirementId, kind: suggestions.kind })
      .from(suggestions)
      .where(and(inArray(suggestions.requirementId, ids), eq(suggestions.status, 'proposed'))),
    activeIssuePrefix(projectId),
    latestPinsOf(ids),
  ]);
  const [people, issueCriteria] = await Promise.all([
    peopleOf([...revisions.map((r) => r.authorId), ...rows.map((r) => r.ownerId)]),
    issueCriteriaOf(linked.map((i) => i.id)),
  ]);
  const by = <T extends { requirementId: string | null }>(list: readonly T[], id: string) =>
    list.filter((x) => x.requirementId === id);
  const phaseBy = new Map(delivery.map((d) => [d.requirementId, d.phase as DeliveryPhase | null]));
  const out = new Map<string, RequirementStanding>();
  for (const row of rows) {
    const mine = by(linked, row.id).map((i) => ({
      id: i.id,
      displayId: formatIssueRef(prefix, i.issSeq),
      title: i.title,
      status: i.status,
      updatedAt: i.updatedAt,
      changedSincePlan: changedSincePlan({ ...i, currentRevision: row.currentRevision }),
    }));
    const issueIds = new Set(mine.map((i) => i.id));
    out.set(
      row.id,
      deriveStanding({
        status: row.status as RequirementStatus,
        phase: phaseBy.get(row.id) ?? null,
        owner: row.ownerId
          ? {
              id: row.ownerId,
              name: people.get(row.ownerId)?.name ?? null,
              kind: people.get(row.ownerId)?.kind ?? 'human',
            }
          : null,
        viewer,
        revisions: by(revisions, row.id).map((r) => ({
          revision: r.revision,
          state: r.state as RevisionState,
          authorId: r.authorId,
          authorName: people.get(r.authorId)?.name ?? null,
          authorKind: people.get(r.authorId)?.kind ?? 'human',
          createdAt: r.createdAt,
          proposedAt: r.proposedAt,
          decidedAt: r.decidedAt,
        })),
        currentRevision: row.currentRevision,
        criteria: by(criteria, row.id),
        issues: mine,
        issueCriteria: issueCriteria.filter((c) => issueIds.has(c.issueId)),
        openSuggestionKinds: by(open, row.id).map((s) => s.kind),
        stalePins: by(pins, row.id).flatMap((p) =>
          p.approved !== null && p.pinned !== null && p.approved > p.pinned
            ? [{ flow: p.flow, pinned: p.pinned, approved: p.approved }]
            : [],
        ),
        updatedAt: row.updatedAt,
        now,
      }),
    );
  }
  return out;
}

/** Which of `ids` read delivered (proven, `standing.ts:provenPhase`) or were accepted. */
export async function deliveredAmong(
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      ownerId: requirements.ownerId,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), inArray(requirements.id, [...ids])));
  const standings = await standingsOf(projectId, rows, null);
  return new Set(
    rows
      .filter((r) => r.status === 'accepted' || standings.get(r.id)?.state === 'delivered')
      .map((r) => r.id),
  );
}

const SUGGESTION_LABEL: Record<string, string> = {
  requirement_draft: 'a requirement draft',
  revision_diff: 'a revision',
  readiness: 'a readiness check',
  breakdown: 'a breakdown',
  triage: 'a triage',
  duplicate: 'a duplicate',
};

const RECORD_KIND_LABEL: Record<string, string> = {
  'record.decision': 'Decision',
  'record.question': 'Question',
  'record.answer': 'Answer',
};

const HISTORY_LIMIT = 80;

function leadOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { lead?: unknown; fields?: unknown };
  if (typeof p.lead === 'string' && p.lead.trim()) return p.lead.trim();
  if (Array.isArray(p.fields)) {
    const first = p.fields.find(
      (f): f is { value: string } => typeof (f as { value?: unknown })?.value === 'string',
    );
    if (first) return first.value;
  }
  return null;
}

function statusMoveOf(payload: unknown): { from: string; to: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const changes = (payload as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  for (const c of changes) {
    const ch = c as { path?: unknown; before?: unknown; after?: unknown };
    if (Array.isArray(ch.path) && ch.path.length === 1 && ch.path[0] === 'status') {
      if (typeof ch.after === 'string')
        return { from: typeof ch.before === 'string' ? ch.before : '', to: ch.after };
    }
  }
  return null;
}

type RevisionRow = typeof requirementRevisions.$inferSelect;
type BaselineRow = typeof requirementBaselines.$inferSelect;
type ReturnRow = typeof requirementReturns.$inferSelect;
type DeferralRow = typeof requirementDeferrals.$inferSelect;
type ActivityRow = typeof activityLog.$inferSelect;
interface SuggestionRow {
  id: string;
  kind: string;
  status: string;
  producerKind: string;
  producerId: string | null;
  decidedBy: string | null;
  reason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

interface Namer {
  who: (id: string | null, fallback: string) => string;
  sourceOf: (id: string | null) => 'person' | 'agent';
}

const entry = (
  e: Omit<RequirementHistoryEntry, 'issue' | 'move'> & Partial<RequirementHistoryEntry>,
): RequirementHistoryEntry => ({ issue: null, move: null, ...e });

function revisionEntries(r: RevisionRow, n: Namer): RequirementHistoryEntry[] {
  const out = [
    entry({
      id: `rev-${r.revision}-written`,
      at: r.createdAt.toISOString(),
      source: n.sourceOf(r.authorId),
      who: n.who(r.authorId, 'Someone'),
      kind: 'Revision',
      text: `Wrote r${r.revision}${r.fromSuggestionId ? ' (an accepted suggestion)' : ''}: ${r.changeSummary ?? r.reason}`,
    }),
  ];
  if (r.proposedAt) {
    out.push(
      entry({
        id: `rev-${r.revision}-proposed`,
        at: r.proposedAt.toISOString(),
        source: n.sourceOf(r.proposedBy ?? r.authorId),
        who: n.who(r.proposedBy ?? r.authorId, 'Someone'),
        kind: 'Revision',
        text: `Proposed r${r.revision}`,
      }),
    );
  }
  if (r.decidedAt && (r.state === 'current' || r.state === 'superseded')) {
    out.push(
      entry({
        id: `rev-${r.revision}-accepted`,
        at: r.decidedAt.toISOString(),
        source: 'person',
        who: n.who(r.decidedBy, 'A signer'),
        kind: 'Decision',
        text: `Accepted r${r.revision}${r.acceptReason ? `: ${r.acceptReason}` : ''}`,
      }),
    );
  }
  return out;
}

// cm:why each return is its own row (requirement_returns), stamped by whoever returned it when they
// did; a later accept never re-dates it
const returnEntry = (r: ReturnRow, n: Namer) =>
  entry({
    id: `return-${r.id}`,
    at: r.returnedAt.toISOString(),
    source: 'person',
    who: n.who(r.returnedBy, 'A signer'),
    kind: 'Returned',
    text: `Returned r${r.revision}: ${r.reason}`,
  });

const deferralEntry = (d: DeferralRow, n: Namer) =>
  entry({
    id: `deferral-${d.id}`,
    at: d.decidedAt.toISOString(),
    source: 'person',
    who: n.who(d.decidedBy, 'A signer'),
    kind: 'Decision',
    text:
      d.act === 'defer'
        ? `Deferred out of the current release${d.targetPhase ? ` (for ${d.targetPhase})` : ''}: ${d.reason ?? ''}`
        : `Undeferred${d.reason ? `: ${d.reason}` : ''}`,
  });

const baselineEntry = (b: BaselineRow, n: Namer) =>
  entry({
    id: `baseline-${b.revision}`,
    at: b.agreedAt.toISOString(),
    source: 'person',
    who: n.who(b.agreedBy, 'A signer'),
    kind: 'Agreed',
    text: `Agreed r${b.revision}${b.reason ? `: ${b.reason}` : ''}`,
  });

function suggestionEntries(s: SuggestionRow, n: Namer): RequirementHistoryEntry[] {
  const label = SUGGESTION_LABEL[s.kind] ?? 'a change';
  const out = [
    entry({
      id: `sug-${s.id}`,
      at: s.createdAt.toISOString(),
      source: s.producerKind === 'person' ? 'person' : 'agent',
      who: s.producerKind === 'ba_assistant' ? 'BA assistant' : n.who(s.producerId, 'An agent'),
      kind: 'Suggestion',
      text: `Suggested ${label}`,
    }),
  ];
  if (s.decidedAt && (s.status === 'accepted' || s.status === 'rejected')) {
    const verb = s.status === 'accepted' ? 'Accepted' : 'Rejected';
    out.push(
      entry({
        id: `sug-${s.id}-${s.status}`,
        at: s.decidedAt.toISOString(),
        source: 'person',
        who: n.who(s.decidedBy, 'Someone'),
        kind: 'Decision',
        text: `${verb} ${label}${s.reason ? `: ${s.reason}` : ''}`,
      }),
    );
  }
  return out;
}

function activityEntry(
  a: ActivityRow,
  issue: string | null,
  n: Namer,
): RequirementHistoryEntry | null {
  if (a.action === 'issue.updated') {
    const move = statusMoveOf(a.payload);
    if (!move) return null;
    return entry({
      id: a.id,
      at: a.createdAt.toISOString(),
      source: 'system',
      who: 'Forge',
      kind: 'Status',
      text: '',
      issue,
      move: { from: move.from || null, to: move.to },
    });
  }
  const actor = a.actorType === 'user' ? n.who(a.actorId, '') : '';
  return entry({
    id: a.id,
    at: a.createdAt.toISOString(),
    source: a.actorAgency === 'agent' ? 'agent' : 'person',
    who: actor || (a.actorAgency === 'agent' ? 'An agent' : 'Someone'),
    kind: RECORD_KIND_LABEL[a.action] ?? 'Record',
    text: leadOf(a.payload) ?? '',
    issue,
  });
}

async function historyRows(requirementId: string, projectId: string) {
  const [revisions, baselines, returns, deferrals, suggested, linked, prefix] = await Promise.all([
    db
      .select()
      .from(requirementRevisions)
      .where(eq(requirementRevisions.requirementId, requirementId)),
    db
      .select()
      .from(requirementBaselines)
      .where(eq(requirementBaselines.requirementId, requirementId)),
    db.select().from(requirementReturns).where(eq(requirementReturns.requirementId, requirementId)),
    db
      .select()
      .from(requirementDeferrals)
      .where(eq(requirementDeferrals.requirementId, requirementId)),
    db
      .select({
        id: suggestions.id,
        kind: suggestions.kind,
        status: suggestions.status,
        producerKind: suggestions.producerKind,
        producerId: suggestions.producerId,
        decidedBy: suggestions.decidedBy,
        reason: suggestions.reason,
        createdAt: suggestions.createdAt,
        decidedAt: suggestions.decidedAt,
      })
      .from(suggestions)
      .where(eq(suggestions.requirementId, requirementId)),
    db
      .select({ id: issues.id, issSeq: issues.issSeq })
      .from(issues)
      .where(eq(issues.requirementId, requirementId)),
    activeIssuePrefix(projectId),
  ]);
  const activity = linked.length
    ? await db
        .select()
        .from(activityLog)
        .where(
          and(
            inArray(
              activityLog.issueId,
              linked.map((i) => i.id),
            ),
            inArray(activityLog.action, [...Object.keys(RECORD_KIND_LABEL), 'issue.updated']),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(HISTORY_LIMIT * 2)
    : [];
  const keyOf = new Map(linked.map((i) => [i.id, formatIssueRef(prefix, i.issSeq)]));
  return { revisions, baselines, returns, deferrals, suggested, activity, keyOf };
}

// cm:why the history is assembled from the rows that already record each act — revisions (written,
// proposed, accepted, returned), baselines (agreed), suggestions (proposed, decided) and the linked
// issues' activity (decisions, questions, answers, status moves) — because requirement writes emit
// no events of their own; feedback (FB-n, ISS-59) does not exist yet and is not faked
export async function historyOf(
  requirementId: string,
  projectId: string,
): Promise<RequirementHistoryEntry[]> {
  const { revisions, baselines, returns, deferrals, suggested, activity, keyOf } =
    await historyRows(requirementId, projectId);
  const people = await peopleOf([
    ...revisions.flatMap((r) => [r.authorId, r.proposedBy, r.decidedBy]),
    ...baselines.map((b) => b.agreedBy),
    ...returns.map((r) => r.returnedBy),
    ...deferrals.map((d) => d.decidedBy),
    ...suggested.flatMap((s) => [s.producerId, s.decidedBy]),
    ...activity.filter((a) => a.actorType === 'user').map((a) => a.actorId),
  ]);
  const n: Namer = {
    who: (id, fallback) => (id ? people.get(id)?.name : undefined) ?? fallback,
    sourceOf: (id) => (id && people.get(id)?.kind === 'agent' ? 'agent' : 'person'),
  };
  const out = [
    ...revisions.flatMap((r) => revisionEntries(r, n)),
    ...baselines.map((b) => baselineEntry(b, n)),
    ...returns.map((r) => returnEntry(r, n)),
    ...deferrals.map((d) => deferralEntry(d, n)),
    ...suggested.flatMap((s) => suggestionEntries(s, n)),
    ...activity.flatMap((a) => activityEntry(a, keyOf.get(a.issueId) ?? null, n) ?? []),
  ];
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, HISTORY_LIMIT);
}
