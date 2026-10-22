/**
 * The lessons folded into the one Needs you read (REQ-50 BC-2, BC-5, BC-7): a lesson the steward
 * proposed from corrections, to approve or reject; a confusion an agent raised instead of guessing,
 * with both sides and its recommendation, to keep, edit or retire the lesson it holds; and a lesson
 * proposed for retirement, to retire or keep. Each answer is the act the Lessons page performs, through
 * the same route and under the same permission, so only a viewer the read grants it is offered it.
 */

import { LESSON_CONFUSION_LABELS } from '@forge/contracts/lessons';
import { type DecisionProposal, fitProposal } from '@forge/contracts/needs-you-proposal';
import { cutAtWord } from '@forge/contracts/title-text';
import { lessonsWaiting, type WaitingConfusion, type WaitingLesson } from '../lessons/index.js';
import { answer, clip, type DecisionBody, filled } from './needs-you-decision-builders.js';

const LESSON = {
  group: 'approve',
  area: 'requirements',
  entity: 'lesson',
  topic: 'lesson',
} as const;

const opens = (key: string) => ({ kind: 'lesson' as const, key });

function proposalOf(
  l: WaitingLesson,
  verb: string,
  consequence: string,
  recommends = false,
): DecisionProposal {
  return fitProposal({
    verb,
    what: l.sentence,
    recommends,
    tags: [{ text: l.key, tone: 'plain' }],
    consequences: [consequence],
    why: l.corrections.slice(0, 6).map((c) => ({ label: c.item.key, value: c.reason })),
    said: null,
    table: null,
    yields: [{ kind: 'approved', n: 1 }],
  });
}

function proposedDecision(projectId: string, l: WaitingLesson): DecisionBody {
  const proposal = proposalOf(
    l,
    'Approve lesson',
    `Every agent in its scope applies ${l.key} from now on`,
  );
  const params = { projectId, lessonKey: l.key };
  return {
    ...LESSON,
    id: `lesson:${l.id}`,
    key: l.key,
    title: cutAtWord(l.sentence, 500),
    opens: opens(l.key),
    question: `Approve lesson ${l.key}, or reject it?`,
    recommended: null,
    noRecommendation:
      'The steward grouped these corrections; check the sentence says what they meant.',
    answers: [
      answer({
        id: 'approve',
        label: 'Approve',
        act: 'lesson.approve',
        path: filled('lesson.approve', params),
        body: {},
        effect: proposal.consequences[0] ?? null,
      }),
      answer({
        id: 'decline',
        label: 'Reject',
        act: 'lesson.reject',
        path: filled('lesson.reject', params),
        body: {},
        needsReason: true,
        declines: true,
        effect: 'No agent applies it; your reason is kept on the lesson.',
      }),
    ],
    touchedAt: l.proposedAt,
    proposal,
  };
}

function retireDecision(projectId: string, l: WaitingLesson): DecisionBody {
  const why =
    l.retire?.reason === 'superseded'
      ? `${l.supersededBy ?? 'A newer lesson'} replaces it.`
      : 'No agent applied it in 30 days.';
  const params = { projectId, lessonKey: l.key };
  return {
    ...LESSON,
    id: `lesson-retire:${l.id}`,
    key: l.key,
    title: cutAtWord(l.sentence, 500),
    opens: opens(l.key),
    question: `Retire lesson ${l.key}, or keep it?`,
    // the approvals grammar: ✓ retires as the rule proposes, with the rule's own reason; Keep is its peek's
    recommended: { answerId: 'approve', why, by: 'rule' },
    noRecommendation: null,
    answers: [
      answer({
        id: 'approve',
        label: 'Retire',
        act: 'lesson.retire',
        path: filled('lesson.retire', params),
        body: { reason: why },
        recommended: true,
        effect: 'No agent applies it any more; the lesson and its history are kept.',
      }),
      answer({
        id: 'keep',
        label: 'Keep',
        act: 'lesson.keep',
        path: filled('lesson.keep', params),
        body: {},
        effect: 'It stays in use, and its unused clock starts again.',
      }),
    ],
    touchedAt: l.retire?.at ?? null,
    proposal: proposalOf(l, 'Retire lesson', `No agent applies ${l.key} any more`, true),
  };
}

/** A side as a quote inside a sentence: its own closing stop dropped. */
const unstopped = (side: string) => side.trim().replace(/[.!?]+$/u, '');

const CHOICE_WORD = { keep: 'keep', edit: 'edit', retire: 'retire' } as const;

/** The choices offered, as one plain question opening: "Keep, edit or retire". */
function choice(offered: readonly (keyof typeof CHOICE_WORD)[]): string {
  const words = offered.map((r) => CHOICE_WORD[r]);
  const said =
    words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? '');
  return said.charAt(0).toUpperCase() + said.slice(1);
}

function confusionDecision(projectId: string, c: WaitingConfusion): DecisionBody {
  const against = c.other.lessonKey ?? c.other.ref;
  const path = filled('lesson.confusion', { projectId, confusionId: c.id });
  const effects = {
    keep: `${c.lessonKey} is applied again as it reads.`,
    edit: `${c.lessonKey} is applied again, reading: ${c.recommended.sentence ?? ''}`,
    retire: `${c.lessonKey} is retired; no agent applies it.`,
  };
  const offered = (['keep', 'edit', 'retire'] as const).filter(
    (r) => r !== 'edit' || c.recommended.sentence,
  );
  return {
    group: 'answer',
    area: LESSON.area,
    entity: LESSON.entity,
    topic: LESSON.topic,
    id: `lesson-confusion:${c.id}`,
    key: c.lessonKey,
    title: LESSON_CONFUSION_LABELS[c.kind],
    opens: opens(c.lessonKey),
    // the question names the choice once; what the two sides say is the why's (REQ-48 r3 BC-14)
    question: `${choice(offered)} ${c.lessonKey}?`,
    recommended: {
      answerId: c.recommended.resolution,
      why: clip(
        `${c.lessonKey} says "${unstopped(c.sides.lesson)}", and ${against ?? 'what it is held against'} says "${unstopped(c.sides.other)}". Recommended by ${c.raisedAgency === 'agent' ? 'the agent that raised it' : 'whoever raised it'}.`,
        600,
      ),
      by: c.raisedAgency === 'agent' ? 'steward' : 'asker',
    },
    noRecommendation: null,
    answers: offered.map((r) =>
      answer({
        id: r,
        label: r === 'keep' ? 'Keep' : r === 'edit' ? 'Edit as recommended' : 'Retire',
        act: 'lesson.confusion',
        path,
        body:
          r === 'edit' ? { resolution: r, sentence: c.recommended.sentence } : { resolution: r },
        effect: effects[r],
        recommended: r === c.recommended.resolution,
      }),
    ),
    touchedAt: c.raisedAt,
    proposal: null,
  };
}

/**
 * The lesson decisions a viewer who may decide them takes (`suggestions.approve`, read by the caller
 * from the access it holds), each built on its own so one bad record breaks nothing else. A viewer
 * who may not decide them is offered none, and nothing is read for them.
 */
export async function lessonDecisionsFor(
  projectId: string,
  mayDecide: boolean,
): Promise<{ key: string; build: () => DecisionBody }[]> {
  if (!mayDecide) return [];
  const waiting = await lessonsWaiting(projectId);
  return [
    ...waiting.confusions.map((c) => ({
      key: c.lessonKey,
      build: () => confusionDecision(projectId, c),
    })),
    ...waiting.lessons.map((l) => ({
      key: l.key,
      build: () =>
        l.status === 'proposed' ? proposedDecision(projectId, l) : retireDecision(projectId, l),
    })),
  ];
}
