import type { Task } from '../task.js';

const facts = [
  'For the next release, note that the release lead is Marta Okafor.',
  'Our deploy window is Wednesday, right after the morning standup.',
  'The staging cluster is called harbor-2 and the production one harbor-1.',
  'The release reviewer is Priya Raman; nothing ships without her sign-off.',
  'The rollback plan is to redeploy the previous tag, which we keep for two weeks.',
  'The status page update goes out fifteen minutes before the deploy.',
  'The release branch is release/harbor and it is cut on Monday.',
  'The smoke test after deploy is the login flow plus one issue create.',
];

const hold = (message: string) => ({
  message,
  checks: [{ kind: 'notFallback' as const }, { kind: 'noHelp' as const }],
});

/** Eight facts over eight turns, a tracker question that displaces them, then a question that needs two of them in order. */
export const longContextThread: Task = {
  id: 'long-context-thread',
  capability: 'long-context',
  intent:
    'Hold release facts given across a long thread and answer a two-part question from them after an unrelated task.',
  // cm:why the rubric names both kinds of turn: the judge reads it on every turn, and on the first beta run (2026-09-16) a last-turn-only wording had it mark eight fact-stating turns partial or no for not naming the reviewer
  judgeRubric:
    'Served means: on a turn that states a fact, the reply takes it in; on the final question, the reply names Priya Raman as reviewer and Wednesday as deploy day from the earlier turns in the reference block, without asking again.',
  budgetSeconds: 600,
  turns: [
    ...facts.map(hold),
    {
      message: 'Unrelated: how many open issues does this project have right now?',
      checks: [
        { kind: 'mustMatch', patterns: [/\d+/] },
        { kind: 'toolsRequired', tools: ['forge'] },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
    {
      message:
        'Back to the release: who reviews it, and on which weekday do we deploy? Answer both, reviewer first.',
      checks: [
        { kind: 'inOrder', patterns: ['Priya Raman', /wednesday/i] },
        {
          kind: 'mustNotMatch',
          patterns: [/which reviewer|what do you mean|remind me|you haven.t told me/i],
        },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
  ],
};
