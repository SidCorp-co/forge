// How a wait names the items its act is about (REQ-12 BC-6, ISS-1184): each by its name, quoted,
// never by its key; an issue by its title's lead, cut as a criterion's row cuts its first clause,
// since a whole title made a two-issue wait eight lines at 390 px. The wait's rule still names the
// criteria's codes and its ref the issue's key, so a reader that links an item has its key.

import { criterionShortTitle } from '@forge/contracts/criterion-title';

const quoted = (name: string) => `“${name}”`;

/** Names already set in words: "A", "A and B", or "A and 2 more", the first named and the rest counted. */
export function joinNames(named: readonly string[]): string {
  const [first, second] = named;
  if (first === undefined) return '';
  if (named.length === 1) return first;
  if (named.length === 2 && second !== undefined) return `${first} and ${second}`;
  return `${first} and ${named.length - 1} more`;
}

/** "“A”", "“A” and “B”", or "“A” and 2 more", each name once. */
export const namesOf = (names: readonly string[]): string =>
  joinNames([...new Set(names)].map(quoted));

/** An issue's title as a wait names it: its lead ("Working agreements C"), else the whole title. */
export const issueName = (title: string): string =>
  criterionShortTitle({ title: null, text: title }).short || title;

/** Issues by the lead of their titles, quoted: "“A”", "“A” and “B”", or "“A” and 2 more". */
export const issuesNamed = (titles: readonly string[]): string => namesOf(titles.map(issueName));
