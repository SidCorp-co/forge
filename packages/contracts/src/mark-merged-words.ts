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

/**
 * What a first mark's commit meets on a project, read off its declaration (core's
 * `markCommitCheck`): checked against a repository Forge reads, kept as a `claim` where none is
 * named, `refused` where one is named that Forge cannot read. Null where it could not be read.
 */
export type MarkCommitCheck = 'checked' | 'claim' | 'refused';

/** Mark merged's panel on a project whose repository Forge cannot read says the same (ISS-1421 r43). */
export const LEAVE_COMMIT_EMPTY = `leave ${COMMIT_FIELD} empty to record a claim naming no commit`;

export const COMMIT_UNREADABLE = `Forge cannot read this project's repository, so a commit named under ${COMMIT_FIELD} is refused; to have one checked, attach a deploy key under ${GIT_ACCESS}`;

/** Mark merged's own steps by what its Commit takes here; `whose` names the properties for several
 *  issues at once: "each issue's". An unread check asks for the commit, as a readable one does. */
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
    return `${use} In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD} and ${LEAVE_COMMIT_EMPTY}. ${COMMIT_UNREADABLE}.`;
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
