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

/** Each missing record by its name, in one short sentence. */
export const ENTRY_RECORD_MISSING: Readonly<Record<EntryCriterionKey, string>> = {
  plan: 'The plan is missing.',
  acceptance_criteria: 'The acceptance criteria are missing.',
  release_note: 'The release note is missing.',
  work_evidence: 'Evidence of the work is missing.',
  merged_mark: 'A merge mark naming where the work landed is missing.',
};

/** Who writes the missing records: the page has no editor for them, so it names the agent's door. */
export function entryRecordsWrittenBy(keys: readonly string[]): string[] {
  const byAgent = keys.filter((k) => k !== 'merged_mark').length;
  const them = byAgent === 1 ? 'it' : 'them';
  return [
    ...(byAgent > 0
      ? [
          `An agent working this issue writes ${them}; Open session or Reopen on its page starts one.`,
        ]
      : []),
    ...(keys.includes('merged_mark')
      ? ["Mark merged in the issue's properties records where the work landed."]
      : []),
  ];
}

/** "a plan", "a plan and acceptance criteria", "a plan, acceptance criteria and a release note". */
export function entryRecordsInWords(keys: readonly string[]): string {
  const words = keys.map(
    (k) => ENTRY_CRITERION_WORDS[k as EntryCriterionKey] ?? k.replace(/_/g, ' '),
  );
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
