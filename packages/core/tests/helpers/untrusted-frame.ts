/**
 * Whether `words` stand inside one of `text`'s untrusted-data frames (`lib/untrusted-text.ts`),
 * never in core's own sentences around them (ISS-1425). A frame's content holds no bracket of its
 * own, so the first close after an open ends it.
 */
export function inUntrustedFrame(text: string, words: string): boolean {
  return text
    .split('⟦UNTRUSTED_DATA')
    .slice(1)
    .some((block) => (block.split('⟦END_UNTRUSTED_DATA⟧')[0] ?? '').includes(words));
}
