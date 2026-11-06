// The owner's conversation on dev, 2026-10-22 (a760cd5f), as the decide tool's tests read it: the
// agreed cluster of steward take-on decisions, the owner's words, and what the conversation keeps
// (`decision-acts.ts`) held in memory, for `decide-tool.test.ts` and `decide-tool-agreed.test.ts`.

import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';

// the owner's two messages on dev, as they wrote them
export const EARLIER = 'Ok mở cho tôi cụm đó đi'; // i18n-allow: the owner's earlier message on dev
export const LATEST = 'Tôi bảo là mở giúp tôi đi'; // i18n-allow: the owner's latest message on dev
export const WORD = 'mở giúp tôi đi'; // i18n-allow: the owner's word on dev

export const PROJECT = 'b9c1e0d4-5a37-4d8e-9a43-1f2a3b4c5d6e';
export const OWNER = '6bdd2f2d-96b0-4018-9668-d58ae9f33207';
export const qid = (n: number) => `00000000-0000-4000-8000-000000000${n}`;

/** A steward's take-on-or-drop decision on a draft, as Needs you builds it. */
export function stewardOpen(seq: number): NeedsYouDecision {
  const path = `/api/questions/${qid(seq)}/answer`;
  const answer = (id: string, label: string, needsReason = false) => ({
    id,
    label,
    act: 'question.answer' as const,
    path,
    body: { round: 1, optionId: id },
    needsReason,
    declines: id === 'steward.drop',
    effect: null,
    recommended: id === 'steward.open',
  });
  return {
    id: `issue:ISS-${seq}:question.answer`,
    group: 'answer',
    area: 'delivery',
    entity: 'issue',
    key: `ISS-${seq}`,
    title: `Draft ${seq}`,
    opens: { kind: 'issue', key: `ISS-${seq}` },
    question: 'Take this draft on, or drop it?',
    recommended: {
      answerId: 'steward.open',
      why: 'It has a requirement and a plan.',
      by: 'steward',
    },
    noRecommendation: null,
    answers: [
      answer('steward.open', 'Open it: admit it for work'),
      answer('steward.drop', 'Drop it', true),
    ],
    touchedAt: '2026-10-22T07:30:00.000Z',
    stuck: false,
    dueAt: null,
    topic: 'issues',
    proposal: null,
  } as unknown as NeedsYouDecision;
}

export const repin = {
  ...stewardOpen(700),
  id: 'repin:wf-1',
  key: 'requirement-to-delivery',
  opens: { kind: 'workflow', key: 'requirement-to-delivery' },
  answers: [
    {
      id: 'approve',
      label: 'Approve',
      act: 'workflow.repin',
      path: '/api/projects/x/workflows/wf-1/repin',
      body: {},
      needsReason: false,
      declines: false,
      effect: null,
      recommended: true,
    },
  ],
  recommended: { answerId: 'approve', why: 'Only a pin moves.', by: 'rule' },
} as unknown as NeedsYouDecision;

export const opened = (key: string, by: string | null, at: string | null) => ({
  key,
  status: 'open',
  movedBy: by,
  movedAt: at,
});

export const CONVERSATION = 'c0000000-0000-4000-8000-000000000001';

/** What waits on the owner now: the read the tool is given. */
export const needsYou: { waiting: NeedsYouDecision[] } = { waiting: [] };

/** One refused act on a decision, as `recordDecisionRefusal` is handed it. */
export interface RefusedAct {
  decisionId: string;
  key: string;
  via: 'card' | 'chat';
  code: string;
  detail: string;
}

/** What the conversation keeps, in memory: the sets put and each act refused. */
export const kept = {
  sets: [] as { id: string; conversationId: string; windowId: string; items: unknown[] }[],
  refused: [] as RefusedAct[],
};

/** `decision-acts.ts` over `kept`; the second refusal of a decision names FB-77 as its feedback item. */
export const memoryDecisionActs = {
  putDecisionSet: async (a: { conversationId: string; windowId: string; items: unknown[] }) => {
    const id = `00000000-0000-4000-9000-00000000000${kept.sets.length}`;
    kept.sets.push({ id, conversationId: a.conversationId, windowId: a.windowId, items: a.items });
    return id;
  },
  newestDecisionSet: async (conversationId: string) =>
    kept.sets.filter((x) => x.conversationId === conversationId).at(-1) ?? null,
  decisionsRefusedTwice: async () => {
    const by = new Map<string, unknown[]>();
    for (const r of kept.refused) {
      by.set(r.decisionId, [...(by.get(r.decisionId) ?? []), { ...r, feedbackKey: 'FB-77' }]);
    }
    for (const [k, v] of by) if (v.length < 2) by.delete(k);
    return by;
  },
  recordDecisionRefusal: async (a: RefusedAct) => {
    kept.refused.push(a);
    const count = kept.refused.filter((r) => r.decisionId === a.decisionId).length;
    return {
      count,
      feedbackKey: count === 2 ? 'FB-77' : null,
      told: count === 2 ? 'Forge recorded the defect in its own feedback as FB-77.' : null,
    };
  },
};
