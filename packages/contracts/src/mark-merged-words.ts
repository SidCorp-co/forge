// Mark merged's own words: its page and core's refusals both read them, so both name it alike.

export const MARK_MERGED_ACTION = 'Mark merged';
export const UNMARK_ACTION = 'Unmark';
export const LATER_MERGE_ACTION = 'Mark a later merge';
export const COMMIT_FIELD = 'Commit';
export const WHERE_IT_LANDED_FIELD = 'Where it landed';
export const WORK_LANDS_ROW = 'Work lands';

/** The act the issue's hold names for a landing in git, so the banner names the same one (ISS-1300 r5). */
export const NAME_THE_LANDED_COMMIT = `name the commit that landed under ${COMMIT_FIELD}`;

export const COMMIT_MAY_STAY_EMPTY = `with no repository named, ${COMMIT_FIELD} may stay empty`;

export function markMergedSteps(outsideGit: boolean, noRepository = false): string {
  if (!outsideGit && noRepository) {
    return `Use ${MARK_MERGED_ACTION} in the issue's properties. In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD}; ${COMMIT_MAY_STAY_EMPTY}.`;
  }
  const fill = outsideGit
    ? `name the live URL, CMS entry or storefront resource in ${WHERE_IT_LANDED_FIELD}`
    : `fill in ${WHERE_IT_LANDED_FIELD} and ${NAME_THE_LANDED_COMMIT}`;
  return `Use ${MARK_MERGED_ACTION} in the issue's properties. In the panel it opens, ${fill}.`;
}

export const MARK_SEEN = 'Forge saw this merge land.';
export const MARK_UNSEEN = 'Forge did not see this merge, so the mark is a claim.';
export const LANDING_UNSEEN = 'Forge did not see it land, so the mark is a claim.';

/** What a mark is, in one sentence: a merge Forge saw, or a claim (ISS-1421 r11). */
export function markIsSentence(kind: string): string {
  if (kind === 'observed') return MARK_SEEN;
  return kind === 'landed' ? LANDING_UNSEEN : MARK_UNSEEN;
}
