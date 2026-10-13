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

const WILDCARD = /\*/g;
const LITERAL_SPECIALS = /[.+?^${}()|[\]\\]/g;

/** Whether `name` is a tag the pattern names. The whole name must match; `*` is the only wildcard. */
export function tagMatchesPattern(pattern: string, name: string): boolean {
  const source = pattern.replace(LITERAL_SPECIALS, '\\$&').replace(WILDCARD, '.*');
  return new RegExp(`^${source}$`, 's').test(name);
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
