import { createHash } from 'node:crypto';

/**
 * A statement's shape: its text with every literal and every parameter list made one mark, so one
 * read sent once a row or once a project reads as one shape however many ids each send carried.
 * It holds no bound value: parameters travel apart from the text, and a literal written into it is
 * replaced here (ISS-1070 r11).
 */
export function shapeOf(text: string): string {
  return (
    text
      // string literals, doubled quotes inside them included
      .replace(/'(?:[^']|'')*'/g, '?')
      .replace(/\$\d+/g, '$n')
      // a number standing alone, never a digit inside a name (`t1`, `iss_seq`)
      .replace(/(?<![\w$])\d+(?:\.\d+)?\b/g, '?')
      // a list of parameters or literals, in parentheses or an ARRAY[...]
      .replace(/\(\s*(?:\$n|\?)(?:\s*,\s*(?:\$n|\?))*\s*\)/g, '(…)')
      .replace(/\[\s*(?:\$n|\?)(?:\s*,\s*(?:\$n|\?))*\s*\]/g, '[…]')
      // many VALUES rows read as one
      .replace(/\(…\)(?:\s*,\s*\(…\))+/g, '(…)')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Above how many shapes the process stops keeping their text: a bound, never an eviction. */
const KEPT = 5000;
/** Each shape's text by its fingerprint, as {@link fingerprintOf} made them in this process. */
const texts = new Map<string, string>();

/**
 * The short fingerprint of a statement's shape ({@link shapeOf}): the same in every process that
 * sends that statement, so a count an operator reads live is turned into its text here, by a test
 * or a log line ({@link shapeTextOf}).
 */
export function fingerprintOf(text: string): string {
  const shape = shapeOf(text);
  const fp = createHash('sha1').update(shape).digest('hex').slice(0, 8);
  if (texts.size < KEPT && !texts.has(fp)) texts.set(fp, shape);
  return fp;
}

/** The shape a fingerprint was made from in this process, or undefined where none was. */
export const shapeTextOf = (fp: string): string | undefined => texts.get(fp);

/** One shape a part of a request sent more than once, with how many times. */
export interface RepeatedShape {
  fingerprint: string;
  count: number;
}

/**
 * The `top` shapes sent more than once among `sent` (each statement text with how many times it
 * was sent), most sent first: texts that differ only in their literals or the length of a
 * parameter list count as one shape.
 */
export function repeatedShapes(sent: ReadonlyMap<string, number>, top: number): RepeatedShape[] {
  const by = new Map<string, number>();
  for (const [text, n] of sent) {
    const fp = fingerprintOf(text);
    by.set(fp, (by.get(fp) ?? 0) + n);
  }
  return [...by]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([fingerprint, count]) => ({ fingerprint, count }));
}
