// Keys for records that carry no id of their own: each record's content, and which occurrence of that
// content it is. A key stays with its record when others are added, removed or reordered around it,
// where a position would hand it to whichever record moved into that place.

/** Each item paired with its key: `contentOf(item)`, then `#n` for the nth repeat of the same content. */
export function keyed<T>(items: readonly T[], contentOf: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const content = contentOf(item);
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    return [n === 0 ? content : `${content}#${n}`, item];
  });
}
