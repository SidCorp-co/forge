/**
 * The approvals folded into the one Needs you read (REQ-48 BC-11): every suggestion an agent proposed
 * that the viewer may decide, every mockup they may accept and every preview they may approve, each a
 * decision with the act that decides it where it is listed and what it proposes (`needs-you-proposals.ts`).
 * One on an issue is listed on the item the issue serves, or left to the master (`needs-you-on-item.ts`).
 * No lesson is one: lessons are internal to Forge, and the steward settles them (REQ-50 BC-9).
 * There is no second approvals read: the page, the Dashboard, /attention, the nav and the chat count
 * this one. Each is checked against the decision schema on its own, so a record no decision can be
 * made of is named under `unreadable` and logged, never the whole read's failure and never dropped.
 */

import type { FeedbackKind, FeedbackSeverity } from '@forge/contracts/feedback';
import { feedbackKey } from '@forge/contracts/feedback';
import type { MockupAcceptConsequence, MockupView } from '@forge/contracts/mockups';
import type { NeedsYouAreaKey, NeedsYouEntity } from '@forge/contracts/needs-you';
import {
  type DecisionOpens,
  type NeedsYouDecision,
  type NotDecisionItem,
  needsYouDecisionSchema,
} from '@forge/contracts/needs-you-decisions';
import {
  type DecisionProposal,
  fitProposal,
  type NeedsYouTopic,
} from '@forge/contracts/needs-you-proposal';
import { cutAtWord } from '@forge/contracts/title-text';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import type { ProjectAccess } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { primeWaitingMockups, waitingMockupsAs } from '../mockups/read.js';
import { holds } from '../permissions/index.js';
import {
  type ApprovablePreview,
  approvablePreviewsOf,
  primeApprovablePreviews,
} from '../previews/read.js';
import { primeOpenQuestionReads } from '../questions/index.js';
import {
  primeWaitingSuggestions,
  type WaitingSuggestion,
  waitingSuggestionsFor,
} from '../suggestions/waiting-read.js';
import type { Attention, NeedsYouViewer } from './needs-you.js';
import { clip, type DecisionBody, filled, prefilledReason } from './needs-you-decision-builders.js';
import { NameOf, nameOf } from './needs-you-named.js';
import { issueItemsOf, type Placement, placeOn } from './needs-you-on-item.js';
import {
  type BrokenDown,
  breakdownProposal,
  suggestionProposal,
  type TriagedItem,
  triageProposal,
} from './needs-you-proposals.js';

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
  place: Placement,
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
        declines: false,
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
        declines: true,
        effect: 'The agent reads your reason and does not propose the same again.',
        recommended: false,
      }
    : null;
  return {
    group: 'approve',
    area: place.area,
    entity: place.entity,
    key: place.key,
    title: cutAtWord(place.title, 500),
    opens: place.opens,
    question: asked(proposal),
    // the requirement it opens is named by its evidence, so its words say "the requirement" (ISS-680 c5)
    changes: `What happens to ${nameOf(place.opens, s.target.key)}, as the agent proposes it`,
    impact: `${NameOf(place.opens, s.target.key)} waits on this; nothing the agent proposed is done until it is approved.`,
    ...approveOrDecline(proposal, approve, decline),
    touchedAt: s.createdAt,
    id: `suggestion:${s.id}`,
    topic: TOPIC_OF[s.kind] ?? (s.target.type === 'feedback' ? 'feedback' : 'requirement'),
    proposal,
  };
}

/** What accepting a mockup does, by the item it is on (REQ-49 BC-7). */
const CONSEQUENCE_OF = {
  requirement: 'pinned_next_baseline',
  issue: 'given_to_issue_jobs',
  feedback: 'kept_on_feedback',
} as const satisfies Record<MockupView['target']['type'], MockupAcceptConsequence>;

/** What accepting it does, its item called as `nameOf` calls it (`Named` opening the line). */
const CONSEQUENCE_LINE: Record<
  MockupAcceptConsequence,
  (on: { named: string; Named: string }) => string
> = {
  pinned_next_baseline: ({ Named }) =>
    `${Named}'s next agree or re-pin pins it, for its issues' jobs`,
  given_to_issue_jobs: ({ Named }) => `${Named}'s jobs are given it`,
  kept_on_feedback: ({ named }) => `It is kept on ${named} as the agreed picture of its fix`,
};

/** A mockup's round, what it revises and its open comments, as the peek's why lines. */
function standingOf(m: MockupView): { label: string; value: string }[] {
  return [
    { label: 'Proposed by', value: m.proposedByName ?? m.proposedAgency },
    ...(m.revises ? [{ label: 'Revision', value: `${m.round}, revising ${m.revises}` }] : []),
    ...(m.comments.open ? [{ label: 'Open comments', value: String(m.comments.open) }] : []),
  ];
}

function mockupDecision(place: Placement, projectId: string, m: MockupView): DecisionBody {
  const consequence = CONSEQUENCE_OF[m.target.type];
  // the requirement it opens is named by its evidence, so its words say "the requirement" (ISS-680 c5)
  const on = { named: nameOf(place.opens, m.target.key), Named: NameOf(place.opens, m.target.key) };
  const proposal: DecisionProposal = fitProposal({
    verb: 'Accept mockup',
    what: m.name,
    recommends: false,
    tags: [{ text: m.kind, tone: 'plain' }],
    consequences: [`${m.key} is accepted for ${on.named}`, CONSEQUENCE_LINE[consequence](on)],
    why: standingOf(m),
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
    declines: false,
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
        declines: true,
        effect: 'It goes back to its author with your reason.',
        recommended: false,
      }
    : null;
  return {
    group: 'approve',
    area: place.area,
    entity: place.entity,
    key: m.key,
    title: cutAtWord(m.name, 500),
    opens: place.opens,
    question: asked(proposal),
    changes: `Whether ${m.key} is the agreed picture for ${on.named}`,
    impact: `${on.Named} waits on this; round ${m.round} stays open until it is decided.`,
    ...approveOrDecline(proposal, approve, decline),
    touchedAt: m.createdAt,
    id: `mockup:${m.id}`,
    topic: 'mockup',
    proposal,
    mockup: {
      key: m.key,
      url: m.url,
      kind: m.kind,
      name: m.name,
      round: m.round,
      revises: m.revises,
      openComments: m.comments.open,
      consequence,
    },
  };
}

function previewDecision(place: Placement, p: ApprovablePreview): DecisionBody {
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
    area: place.area,
    entity: place.entity,
    key: place.key,
    title: cutAtWord(place.title, 500),
    opens: place.opens,
    question: asked(proposal),
    changes: `Whether the running preview of ${p.issueKey} is approved`,
    impact: `${p.issueKey} waits on this; it moves on only once its preview is approved.`,
    ...approveOrDecline(
      proposal,
      {
        id: 'approve',
        label: 'Approve',
        act: 'preview.approve',
        path: filled('preview.approve', { previewId: p.id }),
        body: null,
        needsReason: false,
        declines: false,
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

/** What a suggestion proposes, the record it is on called `named` (`nameOf`). */
function proposalOf(
  s: WaitingSuggestion,
  items: ReadonlyMap<string, TriagedItem>,
  reqs: ReadonlyMap<string, BrokenDown>,
  named: string,
): DecisionProposal {
  if (s.kind === 'feedback_triage') {
    const item = items.get(s.target.id);
    if (!item) throw new Error(`feedback ${s.target.key} the triage is on could not be read`);
    return triageProposal(s.payload, item);
  }
  if (s.kind === 'breakdown') {
    const req = reqs.get(s.target.key);
    if (!req) throw new Error(`requirement ${s.target.key} the breakdown is on is not in the read`);
    return breakdownProposal(s.payload, req, named);
  }
  return suggestionProposal(s.kind, s.payload, named);
}

/** A waiting record no decision could be made of, named by what its source row says of it. */
export interface UnreadableRecord {
  area: NeedsYouAreaKey;
  entity: NeedsYouEntity;
  key: string;
  title: string;
  touchedAt: string | null;
  /** The page it is decided on. */
  opens: DecisionOpens;
}

export interface Folded {
  decisions: NeedsYouDecision[];
  /** The waiting records no decision could be made of: listed by key, opened on their own page. */
  unreadable: UnreadableRecord[];
}

/** A record no decision could be made of, left out by its source row and opened on its own page. */
export const unreadableItem = (u: UnreadableRecord): NotDecisionItem => ({
  key: u.key,
  title: u.title.slice(0, 500) || u.key,
  next: 'open it on its own page',
  opens: u.opens,
});

/** One record as a decision checked on its own, or named unreadable with what broke. */
function checked(
  record: UnreadableRecord,
  build: () => DecisionBody,
  out: Folded,
  projectId: string,
) {
  const { key } = record;
  try {
    const parsed = needsYouDecisionSchema.safeParse({
      ...prefilledReason(build()),
      stuck: false,
      dueAt: null,
    });
    if (parsed.success) {
      out.decisions.push(parsed.data);
      return;
    }
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`).join('; '));
  } catch (err) {
    out.unreadable.push(record);
    // a silence is ours: the page names the key, and the log says what broke
    logger.warn(
      { projectId, key, problem: err instanceof Error ? err.message : String(err) },
      'needs-you: a waiting record could not be made a decision',
    );
  }
}

/**
 * The rows each project's Needs you read sends once a project (its open questions, and the
 * suggestions, mockups and previews this fold makes decisions of), read for every project in
 * `projectIds` in one statement each, so the read across projects costs no statement more a project
 * for them (`needs-you-viewer.ts:readNeedsYouAcross`, `db/read-memo.ts:primeReads`).
 */
export function primeNeedsYouAcross(projectIds: readonly string[]): void {
  primeOpenQuestionReads(projectIds);
  primeWaitingSuggestions(projectIds);
  primeWaitingMockups(projectIds);
  primeApprovablePreviews(projectIds);
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
  const itemOf = issueItemsOf(attention);
  const out: Folded = { decisions: [], unreadable: [] };
  for (const s of suggestions) {
    const place = placeOn(s.target, itemOf);
    if (!place) continue;
    checked(
      { ...place, touchedAt: s.createdAt },
      () =>
        suggestionDecision(
          place,
          projectId,
          s,
          fitProposal(proposalOf(s, items, reqs, nameOf(place.opens, s.target.key))),
        ),
      out,
      projectId,
    );
  }
  for (const m of mockups) {
    const place = placeOn({ ...m.target, title: m.name }, itemOf);
    if (!place) continue;
    checked(
      { ...place, key: m.key, title: m.name, touchedAt: m.createdAt },
      () => mockupDecision(place, projectId, m),
      out,
      projectId,
    );
  }
  for (const p of previews) {
    const place = placeOn({ type: 'issue', key: p.issueKey, title: p.issueTitle }, itemOf);
    if (!place) continue;
    checked({ ...place, touchedAt: p.since }, () => previewDecision(place, p), out, projectId);
  }
  return out;
}
