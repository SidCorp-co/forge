// Mark merged's own words: its page and core's refusals both read them, so both name it alike.

import { GIT_ACCESS } from './deploy-key-words.js';

export const MARK_MERGED_ACTION = 'Mark merged';
export const UNMARK_ACTION = 'Unmark';
export const LATER_MERGE_ACTION = 'Mark a later merge';
export const COMMIT_FIELD = 'Commit';
export const WHERE_IT_LANDED_FIELD = 'Where it landed';
export const WORK_LANDS_ROW = 'Work lands';

/** The act the issue's hold names for a landing in git, so the banner names the same one (ISS-1300 r5). */
export const NAME_THE_LANDED_COMMIT = `name the commit that landed under ${COMMIT_FIELD}`;

export const COMMIT_MAY_STAY_EMPTY = `with no repository named, ${COMMIT_FIELD} may stay empty`;

/** What a first mark's commit meets on a project: core's `markCommitCheck`, null where unread. */
export type MarkCommitCheck = 'checked' | 'claim' | 'refused';

export const LEAVE_COMMIT_EMPTY = `leave ${COMMIT_FIELD} empty to record a claim naming no commit`;

/** Each sentence within the twenty words a close refusal holds to (ISS-1421 criterion 167). */
const COMMIT_UNREADABLE = `Forge cannot read this project's repository, so it refuses a named commit. A deploy key under ${GIT_ACCESS} lets it check one.`;

export function markMergedSteps(
  outsideGit: boolean,
  commit: MarkCommitCheck | null = 'checked',
  whose = "the issue's",
): string {
  const use = `Use ${MARK_MERGED_ACTION} in ${whose} properties.`;
  if (outsideGit) {
    return `${use} In the panel it opens, name the live URL, CMS entry or storefront resource in ${WHERE_IT_LANDED_FIELD}.`;
  }
  if (commit === 'claim') {
    return `${use} In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD}; ${COMMIT_MAY_STAY_EMPTY}.`;
  }
  if (commit === 'refused') {
    return `${use} In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD}. Leave ${COMMIT_FIELD} empty to record a claim naming no commit. ${COMMIT_UNREADABLE}`;
  }
  return `${use} In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD} and ${NAME_THE_LANDED_COMMIT}.`;
}

export const MARK_SEEN = 'Forge saw this merge land.';
export const MARK_UNSEEN = 'Forge did not see this merge, so the mark is a claim.';
export const LANDING_UNSEEN = 'Forge did not see it land, so the mark is a claim.';

/** What a mark is, in one sentence: a merge Forge saw, or a claim (ISS-1421 r11). */
export function markIsSentence(kind: string): string {
  if (kind === 'observed') return MARK_SEEN;
  return kind === 'landed' ? LANDING_UNSEEN : MARK_UNSEEN;
}
