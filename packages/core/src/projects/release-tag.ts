import { z } from 'zod';

export const RELEASE_TAG_PATTERN_MAX = 100;

const PATTERN_CHARACTERS = /^[A-Za-z0-9._/*-]+$/;

export const RELEASE_TAG_PATTERN_SHAPE = `a tag glob of 1 to ${RELEASE_TAG_PATTERN_MAX} characters — letters, digits, \`.\`, \`_\`, \`/\`, \`-\` and \`*\`, where \`*\` matches any run of characters and every other character matches itself, e.g. \`v*\` or \`v*.*.*\``;

export const RELEASE_CHAIN_TAG_PATTERN = 'RELEASE_CHAIN_TAG_PATTERN';

export const releaseTagPatternSchema = z
  .string()
  .min(
    1,
    `${RELEASE_CHAIN_TAG_PATTERN}: a release tag pattern is empty. Send ${RELEASE_TAG_PATTERN_SHAPE}, or leave \`tag\` off the entry for a project that does not release by tag.`,
  )
  .max(
    RELEASE_TAG_PATTERN_MAX,
    `${RELEASE_CHAIN_TAG_PATTERN}: a release tag pattern is longer than ${RELEASE_TAG_PATTERN_MAX} characters. Send ${RELEASE_TAG_PATTERN_SHAPE}.`,
  )
  .refine((pattern) => pattern === '' || PATTERN_CHARACTERS.test(pattern), {
    error: (issue) =>
      `${RELEASE_CHAIN_TAG_PATTERN}: the release tag pattern ${JSON.stringify(issue.input)} holds a character a tag pattern may not. Send ${RELEASE_TAG_PATTERN_SHAPE}.`,
  });

/** Whether `name` is a tag the pattern names: the whole name, `*` the only wildcard. Matched in one pass with a single backtrack point, so no pattern can make it explode. */
export function tagMatchesPattern(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (pattern[p] === '*') {
      star = p;
      p += 1;
      resume = n;
    } else if (p < pattern.length && pattern[p] === name[n]) {
      p += 1;
      n += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** The tags `pattern` names, newest version first, so a refusal can say which one is the latest. */
export function matchingTagsNewestFirst(pattern: string, names: readonly string[]): string[] {
  return names
    .filter((name) => tagMatchesPattern(pattern, name))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

/** The most tags one GitHub reading lists before it refuses rather than read part of the list. */
export const RELEASE_TAG_LIST_CEILING = 1000;

/** Tag comparisons one GitHub reading runs at once. */
export const RELEASE_TAG_COMPARE_BATCH = 10;
