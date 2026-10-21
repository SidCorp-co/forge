/**
 * The approvals folded into the one Needs you read (REQ-48 BC-11): every suggestion an agent proposed
 * that the viewer may decide, every mockup they may accept and every preview they may approve, each a
 * decision with the act that decides it where it is listed and what it proposes (`needs-you-proposals.ts`).
 * There is no second approvals read: the page, the Dashboard, /attention, the nav and the chat count
 * this one. Each is checked against the decision schema on its own, so a record no decision can be
 * made of is named under `unreadable` and logged, never the whole read's failure and never dropped.
 */

import type { FeedbackKind, FeedbackSeverity } from '@forge/contracts/feedback';
import { feedbackKey } from '@forge/contracts/feedback';
import type { MockupView } from '@forge/contracts/mockups';
import type { NeedsYouAreaKey, NeedsYouEntity } from '@forge/contracts/needs-you';
import {
  type NeedsYouDecision,
  needsYouDecisionSchema,
} from '@forge/contracts/needs-you-decisions';
import {
  type DecisionProposal,
  fitProposal,
  type NeedsYouTopic,
} from '@forge/contracts/needs-you-proposal';
import type { SuggestionTargetType } from '@forge/contracts/suggestions';
import { cutAtWord } from '@forge/contracts/title-text';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import type { ProjectAccess } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { waitingMockupsAs } from '../mockups/read.js';
import { holds } from '../permissions/index.js';
import { type ApprovablePreview, approvablePreviewsOf } from '../previews/read.js';
import { type WaitingSuggestion, waitingSuggestionsFor } from '../suggestions/waiting-read.js';
import type { NeedsYouViewer, readAttention } from './needs-you.js';
import { clip, type DecisionBody, filled } from './needs-you-decision-builders.js';
import {
  type BrokenDown,
  breakdownProposal,
  suggestionProposal,
  type TriagedItem,
  triageProposal,
} from './needs-you-proposals.js';

type Attention = Awaited<ReturnType<typeof readAttention>>;

const AREA_OF: Record<SuggestionTargetType, NeedsYouAreaKey> = {
  requirement: 'requirements',
  issue: 'issues',
  feedback: 'feedback',
  workflow: 'designs',
};

const TOPIC_OF: Partial<Record<string, NeedsYouTopic>> = {
  feedback_triage: 'feedback',
  breakdown: 'breakdown',
  design_change: 'design',
};

const asked = (p: DecisionProposal) => clip(p.what ? `${p.verb}: ${p.what}` : p.verb, 2000);

/** The approve and decline of an agent's proposal, the approve recommended where the agent does. */
function approveOrDecline(
  p: DecisionProposal,
  approve: DecisionBody['answers'][number] | null,
  decline: DecisionBody['answers'][number] | null,
): Pick<DecisionBody, 'recommended' | 'noRecommendation' | 'answers'> {
  const recommend = p.recommends && approve !== null;
  const answers = [approve, decline].flatMap((a) =>
    a ? [{ ...a, recommended: recommend && a.id === 'approve' }] : [],
  );
  return {
    recommended: recommend
      ? { answerId: 'approve', why: 'The agent recommends it as proposed.', by: 'steward' }
      : null,
    noRecommendation: recommend
      ? null
      : approve
        ? 'The agent asks you to check it first.'
        : 'You may decline it; approving it takes a permission you do not hold.',
    answers,
  };
}

function suggestionDecision(
  projectId: string,
  s: WaitingSuggestion,
  proposal: DecisionProposal,
): DecisionBody {
  const params = { projectId, suggestionId: s.id };
  const approve = s.mayAccept
    ? {
        id: 'approve',
        label: 'Approve',
        act: 'suggestion.accept' as const,
        path: filled('suggestion.accept', params),
        body: {},
        needsReason: false,
        effect: proposal.consequences[0] ?? null,
        recommended: false,
      }
    : null;
  const decline = s.mayReject
    ? {
        id: 'decline',
        label: 'Decline',
        act: 'suggestion.reject' as const,
        path: filled('suggestion.reject', params),
        body: {},
        needsReason: true,
        effect: 'The agent reads your reason and does not propose the same again.',
        recommended: false,
      }
    : null;
  return {
    group: 'approve',
    area: AREA_OF[s.target.type],
    entity: s.target.type as NeedsYouEntity,
    key: s.target.key,
    title: cutAtWord(s.target.title, 500),
    opens: { kind: s.target.type, key: s.target.key },
    question: asked(proposal),
    ...approveOrDecline(proposal, approve, decline),
    touchedAt: s.createdAt,
    id: `suggestion:${s.id}`,
    topic: TOPIC_OF[s.kind] ?? (s.target.type === 'feedback' ? 'feedback' : 'requirement'),
    proposal,
  };
}

function mockupDecision(projectId: string, m: MockupView): DecisionBody {
  const proposal: DecisionProposal = fitProposal({
    verb: 'Accept mockup',
    what: m.name,
    recommends: false,
    tags: [{ text: m.kind, tone: 'plain' }],
    consequences: [`${m.key} is accepted for ${m.target.key}`],
    why: [{ label: 'Proposed by', value: m.proposedByName ?? m.proposedAgency }],
    said: null,
    table: null,
    yields: [{ kind: 'approved', n: 1 }],
  });
  const params = { projectId, mockupKey: m.key };
  const approve = {
    id: 'approve',
    label: 'Accept',
    act: 'mockup.accept' as const,
    path: filled('mockup.accept', params),
    body: {},
    needsReason: false,
    effect: proposal.consequences[0] ?? null,
    recommended: false,
  };
  const decline = m.can.return
    ? {
        id: 'decline',
        label: 'Return',
        act: 'mockup.return' as const,
        path: filled('mockup.return', params),
        body: {},
        needsReason: true,
        effect: 'It goes back to its author with your reason.',
        recommended: false,
      }
    : null;
  return {
    group: 'approve',
    area:
      m.target.type === 'feedback'
        ? 'feedback'
        : m.target.type === 'issue'
          ? 'issues'
          : 'requirements',
    entity: m.target.type,
    key: m.key,
    title: cutAtWord(m.name, 500),
    opens: { kind: m.target.type, key: m.target.key },
    question: asked(proposal),
    ...approveOrDecline(proposal, approve, decline),
    touchedAt: m.createdAt,
    id: `mockup:${m.id}`,
    topic: 'mockup',
    proposal,
  };
}

function previewDecision(p: ApprovablePreview): DecisionBody {
  const proposal: DecisionProposal = fitProposal({
    verb: 'Approve preview',
    what: p.issueTitle,
    recommends: false,
    tags: [],
    consequences: [`${p.issueKey}'s preview is approved`],
    why: [],
    said: null,
    table: null,
    yields: [{ kind: 'approved', n: 1 }],
  });
  return {
    group: 'approve',
    area: 'issues',
    entity: 'issue',
    key: p.issueKey,
    title: cutAtWord(p.issueTitle, 500),
    opens: { kind: 'issue', key: p.issueKey },
    question: asked(proposal),
    ...approveOrDecline(
      proposal,
      {
        id: 'approve',
        label: 'Approve',
        act: 'preview.approve',
        path: filled('preview.approve', { previewId: p.id }),
        body: null,
        needsReason: false,
        effect: proposal.consequences[0] ?? null,
        recommended: false,
      },
      null,
    ),
    touchedAt: p.since,
    id: `preview:${p.id}`,
    topic: 'preview',
    proposal,
  };
}

/** The feedback items the triage suggestions are on, with what the reporter said. */
async function triagedItemsOf(ids: readonly string[]): Promise<Map<string, TriagedItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: feedback.id,
      seq: feedback.fbSeq,
      kind: feedback.kind,
      severity: feedback.severity,
      body: feedback.body,
      whereSeen: feedback.whereSeen,
    })
    .from(feedback)
    .where(inArray(feedback.id, [...ids]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        key: feedbackKey(r.seq),
        kind: r.kind as FeedbackKind,
        severity: r.severity as FeedbackSeverity,
        body: r.body,
        whereSeen: r.whereSeen,
      },
    ]),
  );
}

/** Each requirement's criteria and the live issues already carrying it, for a breakdown's check. */
function brokenDownOf(attention: Attention): Map<string, BrokenDown> {
  const carried = new Map<string, string[]>();
  for (const i of attention.issues.issues) {
    const req = i.standing.requirement?.key;
    if (!req || i.status === 'draft' || i.status === 'dropped') continue;
    carried.set(req, [...(carried.get(req) ?? []), i.key]);
  }
  return new Map(
    attention.requirements.map((r) => [
      r.key,
      { key: r.key, criteria: r.standing.facts.criteria, carriedBy: carried.get(r.key) ?? [] },
    ]),
  );
}

function proposalOf(
  s: WaitingSuggestion,
  items: ReadonlyMap<string, TriagedItem>,
  reqs: ReadonlyMap<string, BrokenDown>,
): DecisionProposal {
  if (s.kind === 'feedback_triage') {
    const item = items.get(s.target.id);
    if (!item) throw new Error(`feedback ${s.target.key} the triage is on could not be read`);
    return triageProposal(s.payload, item);
  }
  if (s.kind === 'breakdown') {
    const req = reqs.get(s.target.key);
    if (!req) throw new Error(`requirement ${s.target.key} the breakdown is on is not in the read`);
    return breakdownProposal(s.payload, req);
  }
  return suggestionProposal(s.kind, s.payload, s.target.key);
}

export interface Folded {
  decisions: NeedsYouDecision[];
  /** The keys of the waiting records no decision could be made of. */
  unreadable: string[];
}

/** One record as a decision checked on its own, or its key named unreadable with what broke. */
function checked(key: string, build: () => DecisionBody, out: Folded, projectId: string) {
  try {
    const parsed = needsYouDecisionSchema.safeParse({ ...build(), stuck: false, dueAt: null });
    if (parsed.success) {
      out.decisions.push(parsed.data);
      return;
    }
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`).join('; '));
  } catch (err) {
    out.unreadable.push(key);
    // a silence is ours: the page names the key, and the log says what broke
    logger.warn(
      { projectId, key, problem: err instanceof Error ? err.message : String(err) },
      'needs-you: a waiting record could not be made a decision',
    );
  }
}

export async function foldedDecisions(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  attention: Attention,
): Promise<Folded> {
  const [suggestions, mockups, previews] = await Promise.all([
    waitingSuggestionsFor(projectId, (p) => holds(access, p)),
    waitingMockupsAs(projectId, { userId: viewer.userId, agency: viewer.agency }),
    holds(access, 'previews.approve') ? approvablePreviewsOf(projectId) : [],
  ]);
  const items = await triagedItemsOf(
    suggestions.filter((s) => s.kind === 'feedback_triage').map((s) => s.target.id),
  );
  const reqs = brokenDownOf(attention);
  const out: Folded = { decisions: [], unreadable: [] };
  for (const s of suggestions) {
    checked(
      s.target.key,
      () => suggestionDecision(projectId, s, fitProposal(proposalOf(s, items, reqs))),
      out,
      projectId,
    );
  }
  for (const m of mockups) checked(m.key, () => mockupDecision(projectId, m), out, projectId);
  for (const p of previews) checked(p.issueKey, () => previewDecision(p), out, projectId);
  return out;
}
