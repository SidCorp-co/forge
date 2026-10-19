// Mark merged's own words: its page and core's refusals both read them, so both name it alike.

export const MARK_MERGED_ACTION = 'Mark merged';
export const UNMARK_ACTION = 'Unmark';
export const WHERE_IT_LANDED_FIELD = 'Where it landed';
export const WORK_LANDS_ROW = 'Work lands';

export function markMergedSteps(outsideGit: boolean): string {
  const fill = outsideGit
    ? `name the live URL, CMS entry or storefront resource in ${WHERE_IT_LANDED_FIELD}`
    : `fill in ${WHERE_IT_LANDED_FIELD}`;
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
