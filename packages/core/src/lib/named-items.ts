// How a wait names the items its act is about (REQ-12 BC-6, ISS-1184): each by its name, quoted,
// never by its key. The producer still says the keys beside the names, so a reader that links an
// item has its key behind the words.

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
