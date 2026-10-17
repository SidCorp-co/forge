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
  'declaredLandingShape',
] as const;

/** Each entry record as a reader names it: never its stored key (ISS-1421 r4). */
export const ENTRY_CRITERION_WORDS: Readonly<Record<EntryCriterionKey, string>> = {
  plan: 'a plan',
  acceptance_criteria: 'acceptance criteria',
  release_note: 'a release note',
  work_evidence: 'evidence of the work',
  merged_mark: 'a merge mark',
};

/** "a plan", "a plan and acceptance criteria", "a plan, acceptance criteria and a release note". */
export function entryRecordsInWords(keys: readonly string[]): string {
  const words = keys.map(
    (k) => ENTRY_CRITERION_WORDS[k as EntryCriterionKey] ?? k.replace(/_/g, ' '),
  );
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
