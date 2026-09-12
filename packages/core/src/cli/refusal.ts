/**
 * The refusal a filing meets at this door, and the one line a filing that was
 * accepted still earns.
 *
 * Rendering only. Every word of what was read and what the shape wants comes
 * from `shape.ts` and `kinds.ts`, so the refusal cannot claim a rule the
 * reader did not apply.
 */

import { type CliSection, article, listed } from './kinds.js';
import type { CliGap, CliShape } from './shape.js';

export const SHAPE_HEAD =
  'Hold — this files an issue the flow cannot carry. Each line below is what was read, ' +
  'what the shape wants and the one command that clears it.';

function rendered(gaps: readonly CliGap[]): string {
  return gaps.map((one) => `- read: ${one.read}\n  wants: ${one.wants}\n  clear: ${one.clear}`).join('\n');
}

/** Null where nothing was read as a gap: a filing with no gaps is filed, and this returns nothing to say of it. */
export function shapeRefusal(shape: CliShape): string | null {
  return shape.gaps.length ? [SHAPE_HEAD, rendered(shape.gaps)].join('\n\n') : null;
}

export interface DuplicateSeen {
  readonly key: string;
  readonly title: string;
}

// cm:guard the way out has to be a FLAG the door reads, never a sentence it does not. The check is word overlap and not meaning — "Dark mode broken on the settings page" and "…on the profile page" score 0.750 — so a caller with only prose to answer with cannot restate its way past a deterministic check, and every false positive is final. `assistant/tools/registry.ts` carries the same escape under the same name for the same reason; one word for one thing across doors.
// cm:edge naming -> packages/core/src/assistant/tools/registry.ts — `DEDUP_OVERRIDE_KEY` is this word at the chat door. Renaming it in one place gives a filer two names for one act.
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
