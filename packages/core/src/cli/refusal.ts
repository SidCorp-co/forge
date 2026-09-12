/**
 * Rendering what was read into the refusal a filer meets.
 *
 * The refusal IS the deliverable: a layer that accepts a malformed filing and reports success has
 * done nothing (ISS-985).
 */

import type { DuplicateMatch } from '../assistant/tools/issue-dedup.js';
import type { FilingGap } from './shape.js';

const HEAD =
  'Hold — this files an issue the flow cannot carry. Each line below is what was read, what the ' +
  'shape wants and the one thing that clears it.';

function rendered(gaps: readonly FilingGap[]): string {
  return gaps
    .map((one) => `- read: ${one.read}\n  wants: ${one.wants}\n  clear: ${one.clear}`)
    .join('\n');
}

export function shapeRefusal(gaps: readonly FilingGap[]): string {
  return [HEAD, rendered(gaps)].join('\n\n');
}

/** The matched issue's key is the point of the line: a filer cannot comment on a key nobody named. */
export function duplicateRefusal(match: DuplicateMatch): string {
  const key = `ISS-${match.issSeq}`;
  return (
    `Hold — this filing reads like ${key} \`${match.title}\`, which is already open.` +
    `\n- read: the title and body of this filing, against ${key}` +
    '\n  wants: one issue per problem' +
    `\n  clear: comment on ${key} instead, or send the filing again saying how it differs`
  );
}
