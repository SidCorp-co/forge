/**
 * Who judges a change between `developed` and `testing` — the project's answer, stored once.
 *
 * `independent` — a run other than the one that built the change writes the verdicts.
 * `builder` — the run that built it judges its own work.
 *
 * The key and both spellings live HERE and nowhere else, because they are read across a repository
 * boundary this repo cannot gate and were unreadable for four weeks without anyone noticing.
 */
export const QA_JUDGEMENT_KEY = 'qa' as const;

export const QA_JUDGEMENT_MODES = ['independent', 'builder'] as const;

export type QaJudgementMode = (typeof QA_JUDGEMENT_MODES)[number];
