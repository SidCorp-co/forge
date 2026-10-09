export const feedbackKinds = [
  'friction',
  'bug',
  'skill_gap',
  'unclear_step',
  'redundant_step',
  'learning',
  'suggestion',
] as const;
export type FeedbackKind = (typeof feedbackKinds)[number];

export const feedbackSeverities = ['low', 'medium', 'high'] as const;
export type FeedbackSeverity = (typeof feedbackSeverities)[number];

export const feedbackTargets = [
  'skill',
  'prompt',
  'tool',
  'doc',
  'orientation',
  'pipeline',
  'other',
] as const;
export type FeedbackTarget = (typeof feedbackTargets)[number];
