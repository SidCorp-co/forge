export const ENTRY_CRITERION_KEYS = [
  'plan',
  'acceptance_criteria',
  'release_note',
  'work_evidence',
  'merged_mark',
] as const;

export type EntryCriterionKey = (typeof ENTRY_CRITERION_KEYS)[number];

export const CONTRACT_INPUT_FIELDS = [
  'plan',
  'acceptanceCriteria',
  'releaseNotes',
  'mergedAt',
  'sessionContext',
] as const;
