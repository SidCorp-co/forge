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
