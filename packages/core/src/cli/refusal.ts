import { article, type CliSection, listed } from './kinds.js';
import type { CliGap, CliShape } from './shape.js';

export const SHAPE_HEAD =
  'Hold — this files an issue the flow cannot carry. Each line below is what was read, ' +
  'what the shape wants and the one command that clears it.';

function rendered(gaps: readonly CliGap[]): string {
  return gaps
    .map((one) => `- read: ${one.read}\n  wants: ${one.wants}\n  clear: ${one.clear}`)
    .join('\n');
}

/** Null where nothing was read as a gap: a filing with no gaps is filed, and this returns nothing to say of it. */
export function shapeRefusal(shape: CliShape): string | null {
  return shape.gaps.length ? [SHAPE_HEAD, rendered(shape.gaps)].join('\n\n') : null;
}

export interface DuplicateSeen {
  readonly key: string;
  readonly title: string;
}

export function duplicateGap(seen: DuplicateSeen, override: string): CliGap {
  return {
    because: 'duplicate',
    read: `a filing reading like ${seen.key} \`${seen.title}\`, which is open`,
    wants: 'one issue per problem',
    clear:
      `post this body as a comment on ${seen.key}; where it is genuinely a different problem` +
      ` — two screens, two releases, two customers — send the filing again with \`${override}\``,
  };
}

export function duplicateRefusal(seen: DuplicateSeen, override: string): string {
  return [SHAPE_HEAD, rendered([duplicateGap(seen, override)])].join('\n\n');
}

/** One line or nothing, and never a refusal: what the body was read as, and what it left out. */
export function noticeFor(read: { kind: string; left: readonly CliSection[] }): string | null {
  if (!read.left.length) return null;
  return (
    `Read as ${article(read.kind)} ${read.kind}. It leaves out` +
    ` ${listed(read.left.map((one) => one.title))}, nice to have on ${article(read.kind)} ${read.kind}` +
    ' and refused on nothing.'
  );
}
