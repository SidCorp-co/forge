import { type MarkCommitCheck, markMergedSteps } from '@forge/contracts/mark-merged-words';

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

/** Each entry record named as the subject of "… is missing" (ISS-1421 r14). */
const ENTRY_RECORD_NAMED: Readonly<Record<EntryCriterionKey, string>> = {
  plan: 'the plan',
  acceptance_criteria: 'the acceptance criteria',
  release_note: 'the release note',
  work_evidence: 'evidence of the work',
  merged_mark: 'a merge mark',
};

const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five'];
const MAX_SENTENCE_WORDS = 20;

/**
 * "This issue can't close yet: the plan and the release note are missing." A sentence that would
 * run past twenty words says how many records are missing and lists them in a second one.
 */
export function entryRecordsMissingWords(
  toStatus: string,
  toLabel: string,
  keys: readonly EntryCriterionKey[],
): string {
  const move = toStatus === 'closed' ? 'close' : `move to ${toLabel}`;
  const names = keys.map((k) => ENTRY_RECORD_NAMED[k]);
  const listed =
    names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const plural = keys.length > 1 || keys[0] === 'acceptance_criteria';
  const whole = `This issue can't ${move} yet: ${listed} ${plural ? 'are' : 'is'} missing.`;
  if (whole.split(/\s+/).length <= MAX_SENTENCE_WORDS) return whole;
  return `This issue can't ${move} yet: ${COUNT_WORDS[keys.length] ?? keys.length} records are missing. They are ${listed}.`;
}

/** How a missing mark is made, where its lane was read: whether the work lands outside git, and in
 *  git what a mark's commit meets on the project (`markCommitCheck`). */
export interface MissingMarkShape {
  outsideGit: boolean;
  commit: MarkCommitCheck | null;
}

/** Who writes the missing records: the page has no editor for them, so it names the agent's door.
 *  A missing mark is Mark merged's own steps (ISS-1421 r42), or with `mark` null only what it records. */
export function entryRecordsWrittenBy(
  keys: readonly string[],
  mark: MissingMarkShape | null = null,
): string[] {
  const byAgent = keys.filter((k) => k !== 'merged_mark').length;
  const them = byAgent === 1 ? 'it' : 'them';
  return [
    ...(byAgent > 0
      ? [
          `An agent working this issue writes ${them}; Open session or Reopen on its page starts one.`,
        ]
      : []),
    ...(keys.includes('merged_mark')
      ? [
          mark
            ? markMergedSteps(mark.outsideGit, mark.commit)
            : "Mark merged in the issue's properties records where the work landed.",
        ]
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
