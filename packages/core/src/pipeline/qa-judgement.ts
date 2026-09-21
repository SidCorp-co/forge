export const QA_JUDGEMENT_KEY = 'qa' as const;

export const QA_JUDGEMENT_MODES = ['independent', 'builder'] as const;

export type QaJudgementMode = (typeof QA_JUDGEMENT_MODES)[number];
