/**
 * The history a requirement's page reads: its revisions, agrees, suggestions and pictures, its
 * own moves to accepted and dropped, and the decisions, questions and status moves recorded on its
 * linked issues.
 */

import { issueUpdatedAsChanges } from '@forge/contracts/field-changes';
import type { BaselineReadiness, RequirementHistoryEntry } from '@forge/contracts/requirements';
import { type Said, type SaidPlainKey, say, sayEn, verbatim } from '@forge/contracts/said';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, issues, kernelTransitions } from '../db/schema.js';
import {
  requirementBaselines,
  requirementDeferrals,
  requirementReturns,
  requirementRevisions,
} from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { type PictureRow, pictureRowsOf } from './picture-read.js';

const SUGGESTION_LABEL: Record<string, SaidPlainKey> = {
  requirement_draft: 'requirements.history.what.requirement_draft',
  revision_diff: 'requirements.history.what.revision_diff',
  readiness: 'requirements.history.what.readiness',
  breakdown: 'requirements.history.what.breakdown',
  triage: 'requirements.history.what.triage',
  duplicate: 'requirements.history.what.duplicate',
};

const RECORD_KIND_LABEL: Record<string, Said> = {
  'record.decision': say('requirements.history.kind.Decision'),
  'record.question': say('requirements.history.kind.Question'),
  'record.answer': say('requirements.history.kind.Answer'),
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

function statusMoveOf(stored: unknown): { from: string; to: string } | null {
  // ISS-124 amnesty (`activity-snapshot-read`): a row the boot backfill has not converted reads as its changes.
  let payload: unknown;
  try {
    payload = issueUpdatedAsChanges(stored);
  } catch {
    return null;
  }
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
type MoveRow = Pick<
  typeof kernelTransitions.$inferSelect,
  'id' | 'toStatus' | 'reason' | 'actorId' | 'createdAt'
>;
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
  who: (id: string | null, fallback: Said) => Said;
  sourceOf: (id: string | null) => 'person' | 'agent';
}

const SOMEONE = say('requirements.history.who.someone');
const SIGNER = say('requirements.history.who.signer');
const AN_AGENT = say('requirements.history.who.agent');

type EntryInput = Omit<
  RequirementHistoryEntry,
  'issue' | 'move' | 'who' | 'text' | 'kind' | 'says'
> &
  Partial<Pick<RequirementHistoryEntry, 'issue' | 'move'>> & { who: Said; text: Said; kind: Said };

/** A history entry from what it says: its English `who`, `text` and `kind` rendered from `says`. */
const entry = ({ who, text, kind, ...e }: EntryInput): RequirementHistoryEntry => ({
  issue: null,
  move: null,
  ...e,
  kind: sayEn(kind),
  who: sayEn(who),
  text: sayEn(text),
  says: { who, text, kind },
});

function revisionEntries(r: RevisionRow, n: Namer): RequirementHistoryEntry[] {
  const out = [
    entry({
      id: `rev-${r.revision}-written`,
      at: r.createdAt.toISOString(),
      source: n.sourceOf(r.authorId),
      who: n.who(r.authorId, SOMEONE),
      kind: say('requirements.history.kind.Revision'),
      text: say(
        r.fromSuggestionId
          ? 'requirements.history.text.wroteSuggested'
          : 'requirements.history.text.wrote',
        { r: r.revision, rest: r.changeSummary ?? r.reason },
      ),
    }),
  ];
  if (r.proposedAt) {
    out.push(
      entry({
        id: `rev-${r.revision}-proposed`,
        at: r.proposedAt.toISOString(),
        source: n.sourceOf(r.proposedBy ?? r.authorId),
        who: n.who(r.proposedBy ?? r.authorId, SOMEONE),
        kind: say('requirements.history.kind.Revision'),
        text: say('requirements.history.text.proposed', { r: r.revision }),
      }),
    );
  }
  if (r.decidedAt && (r.state === 'current' || r.state === 'superseded')) {
    out.push(
      entry({
        id: `rev-${r.revision}-accepted`,
        at: r.decidedAt.toISOString(),
        source: 'person',
        who: n.who(r.decidedBy, SIGNER),
        kind: say('requirements.history.kind.Decision'),
        text: r.acceptReason
          ? say('requirements.history.text.acceptedWhy', { r: r.revision, rest: r.acceptReason })
          : say('requirements.history.text.accepted', { r: r.revision }),
      }),
    );
  }
  return out;
}

// Each picture written is its own row (requirement_pictures), so a replaced one stays here with who
// drew it and when (Requirement lifecycle r14 `picture_shown`); a picture is a replace where one was
// already drawn for the same revision
function pictureEntries(pictures: readonly PictureRow[], n: Namer): RequirementHistoryEntry[] {
  const drawn = new Set<number>();
  return pictures.map((p) => {
    const replaced = drawn.has(p.drawnFor);
    drawn.add(p.drawnFor);
    return entry({
      id: `picture-${p.id}`,
      at: p.writtenAt.toISOString(),
      source: p.writtenAgency === 'agent' ? 'agent' : 'person',
      who: n.who(p.writtenBy, SOMEONE),
      kind: say('requirements.history.kind.Picture'),
      text: say(
        replaced
          ? 'requirements.history.text.pictureReplaced'
          : 'requirements.history.text.pictureDrawn',
        { r: p.drawnFor, rest: p.alt },
      ),
    });
  });
}

// Each return is its own row (requirement_returns), stamped by whoever returned it when they
// did; a later accept never re-dates it
const returnEntry = (r: ReturnRow, n: Namer) =>
  entry({
    id: `return-${r.id}`,
    at: r.returnedAt.toISOString(),
    source: 'person',
    who: n.who(r.returnedBy, SIGNER),
    kind: say('requirements.history.kind.Returned'),
    text: say('requirements.history.text.returned', { r: r.revision, rest: r.reason }),
  });

const deferralEntry = (d: DeferralRow, n: Namer) =>
  entry({
    id: `deferral-${d.id}`,
    at: d.decidedAt.toISOString(),
    source: 'person',
    who: n.who(d.decidedBy, SIGNER),
    kind: say('requirements.history.kind.Decision'),
    text:
      d.act === 'defer'
        ? d.targetPhase
          ? say('requirements.history.text.deferredFor', {
              phase: d.targetPhase,
              rest: d.reason ?? '',
            })
          : say('requirements.history.text.deferred', { rest: d.reason ?? '' })
        : d.reason
          ? say('requirements.history.text.undeferredWhy', { rest: d.reason })
          : say('requirements.history.text.undeferred'),
  });

const baselineEntry = (b: BaselineRow, n: Namer) =>
  entry({
    id: `baseline-${b.revision}-${b.seq}`,
    at: b.agreedAt.toISOString(),
    source: 'person',
    who: n.who(b.agreedBy, SIGNER),
    kind: say('requirements.history.kind.Agreed'),
    text: noted(baselineText(b), readinessNote(b.readiness)),
  });

function baselineText(b: BaselineRow): Said {
  const r = b.revision;
  if (b.act === 'repin') {
    return b.reason
      ? say('requirements.history.text.repinnedWhy', { r, rest: b.reason })
      : say('requirements.history.text.repinned', { r });
  }
  return b.reason
    ? say('requirements.history.text.agreedWhy', { r, rest: b.reason })
    : say('requirements.history.text.agreed', { r });
}

const noted = (text: Said, note: Said | null): Said =>
  note ? say('requirements.history.text.noted', { text, note }) : text;

// A delivery accept and a drop write no row of their own: the requirement's kernel transition is
// their record, the signer's reason on it (ISS-281)
const MOVES_READ = ['accepted', 'dropped'];

function moveText(m: MoveRow): Said {
  if (m.toStatus === 'accepted') {
    return m.reason
      ? say('requirements.history.text.deliveryAcceptedWhy', { rest: m.reason })
      : say('requirements.history.text.deliveryAccepted');
  }
  if (m.toStatus === 'dropped')
    return say('requirements.history.text.dropped', { rest: m.reason ?? '' });
  throw new Error(
    `history-read: read a requirement move to ${m.toStatus}; only ${MOVES_READ.join(' and ')} are read`,
  );
}

const moveEntry = (m: MoveRow, n: Namer) =>
  entry({
    id: `move-${m.id}`,
    at: m.createdAt.toISOString(),
    source: n.sourceOf(m.actorId),
    who: n.who(m.actorId, SIGNER),
    kind: say('requirements.history.kind.Decision'),
    text: moveText(m),
  });

// A dedup check stored before core said it carries only its English (`near-duplicate.ts:checkOf`);
// read back to its key, any other sentence carried as written.
const NOT_CHECKED = /^dedup was not checked: the head revision's vector is (.+)$/;

function dedupWhy(d: NonNullable<BaselineReadiness['dedup']>): Said | null {
  if (d.ran) return null;
  if (d.says) return d.says.why;
  const m = NOT_CHECKED.exec(d.why);
  if (!m) return verbatim(d.why);
  return m[1] === 'not written yet'
    ? say('requirements.dedup.notWritten')
    : say('requirements.dedup.notChecked', { status: m[1] as string });
}

function readinessNote(r: BaselineRow['readiness']): Said | null {
  if (!r) return null;
  const why = r.dedup ? dedupWhy(r.dedup) : null;
  const dedup = why ? say('requirements.history.note.dedup', { why }) : null;
  if (r.gate === 'off') return dedup;
  if (r.ready) return say('requirements.history.note.ready', { dedup });
  if (r.suggestionId === null) return say('requirements.history.note.noResult', { dedup });
  return say('requirements.history.note.notReady', { failed: r.failed.join(', '), dedup });
}

function suggestionEntries(s: SuggestionRow, n: Namer): RequirementHistoryEntry[] {
  const what = say(SUGGESTION_LABEL[s.kind] ?? 'requirements.history.what.change');
  const out = [
    entry({
      id: `sug-${s.id}`,
      at: s.createdAt.toISOString(),
      source: s.producerKind === 'person' ? 'person' : 'agent',
      who:
        s.producerKind === 'ba_assistant'
          ? say('requirements.history.who.assistant')
          : n.who(s.producerId, AN_AGENT),
      kind: say('requirements.history.kind.Suggestion'),
      text: say('requirements.history.text.suggested', { what }),
    }),
  ];
  if (s.decidedAt && (s.status === 'accepted' || s.status === 'rejected')) {
    const accepted = s.status === 'accepted';
    const text = s.reason
      ? say(
          accepted
            ? 'requirements.history.text.acceptedSuggestionWhy'
            : 'requirements.history.text.rejectedSuggestionWhy',
          { what, rest: s.reason },
        )
      : say(
          accepted
            ? 'requirements.history.text.acceptedSuggestion'
            : 'requirements.history.text.rejectedSuggestion',
          { what },
        );
    out.push(
      entry({
        id: `sug-${s.id}-${s.status}`,
        at: s.decidedAt.toISOString(),
        source: 'person',
        who: n.who(s.decidedBy, SOMEONE),
        kind: say('requirements.history.kind.Decision'),
        text,
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
      who: say('requirements.history.who.forge'),
      kind: say('requirements.history.kind.Status'),
      text: say('standing.empty'),
      issue,
      move: { from: move.from || null, to: move.to },
    });
  }
  const fallback = a.actorAgency === 'agent' ? AN_AGENT : SOMEONE;
  const lead = leadOf(a.payload);
  return entry({
    id: a.id,
    at: a.createdAt.toISOString(),
    source: a.actorAgency === 'agent' ? 'agent' : 'person',
    who: a.actorType === 'user' ? n.who(a.actorId, fallback) : fallback,
    kind: RECORD_KIND_LABEL[a.action] ?? say('requirements.history.kind.Record'),
    text: lead ? verbatim(lead) : say('standing.empty'),
    issue,
  });
}

async function historyRows(requirementId: string, projectId: string) {
  const [revisions, baselines, returns, deferrals, moves, suggested, linked, prefix] =
    await Promise.all([
      db
        .select()
        .from(requirementRevisions)
        .where(eq(requirementRevisions.requirementId, requirementId)),
      db
        .select()
        .from(requirementBaselines)
        .where(eq(requirementBaselines.requirementId, requirementId)),
      db
        .select()
        .from(requirementReturns)
        .where(eq(requirementReturns.requirementId, requirementId)),
      db
        .select()
        .from(requirementDeferrals)
        .where(eq(requirementDeferrals.requirementId, requirementId)),
      db
        .select({
          id: kernelTransitions.id,
          toStatus: kernelTransitions.toStatus,
          reason: kernelTransitions.reason,
          actorId: kernelTransitions.actorId,
          createdAt: kernelTransitions.createdAt,
        })
        .from(kernelTransitions)
        .where(
          and(
            eq(kernelTransitions.entity, 'requirement'),
            eq(kernelTransitions.entityId, requirementId),
            inArray(kernelTransitions.toStatus, MOVES_READ),
          ),
        ),
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
  return { revisions, baselines, returns, deferrals, moves, suggested, activity, keyOf };
}

// The history is assembled from the rows that already record each act — revisions (written,
// proposed, accepted, returned), baselines (agreed), the requirement's kernel moves (delivery
// accepted, dropped), suggestions (proposed, decided) and the linked
// issues' activity (decisions, questions, answers, status moves) — because requirement writes emit
// no events of their own. Feedback acts are left out on purpose: the detail lists the requirement's
// feedback with its own phase, so the history does not repeat them
export async function historyOf(
  requirementId: string,
  projectId: string,
): Promise<RequirementHistoryEntry[]> {
  const [
    { revisions, baselines, returns, deferrals, moves, suggested, activity, keyOf },
    pictures,
  ] = await Promise.all([historyRows(requirementId, projectId), pictureRowsOf(requirementId)]);
  const people = await peopleOf([
    ...pictures.map((p) => p.writtenBy),
    ...revisions.flatMap((r) => [r.authorId, r.proposedBy, r.decidedBy]),
    ...baselines.map((b) => b.agreedBy),
    ...returns.map((r) => r.returnedBy),
    ...deferrals.map((d) => d.decidedBy),
    ...moves.map((m) => m.actorId),
    ...suggested.flatMap((s) => [s.producerId, s.decidedBy]),
    ...activity.filter((a) => a.actorType === 'user').map((a) => a.actorId),
  ]);
  const n: Namer = {
    who: (id, fallback) => {
      const name = id ? people.get(id)?.name : undefined;
      return name ? say('standing.who.named', { name }) : fallback;
    },
    sourceOf: (id) => (id && people.get(id)?.kind === 'agent' ? 'agent' : 'person'),
  };
  const out = [
    ...revisions.flatMap((r) => revisionEntries(r, n)),
    ...baselines.map((b) => baselineEntry(b, n)),
    ...returns.map((r) => returnEntry(r, n)),
    ...deferrals.map((d) => deferralEntry(d, n)),
    ...pictureEntries(pictures, n),
    ...moves.map((m) => moveEntry(m, n)),
    ...suggested.flatMap((s) => suggestionEntries(s, n)),
    ...activity.flatMap((a) => activityEntry(a, keyOf.get(a.issueId) ?? null, n) ?? []),
  ];
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, HISTORY_LIMIT);
}
