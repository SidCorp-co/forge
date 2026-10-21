/**
 * The vet a steward note passes at write (REQ-48 BC-8; docs/proposals/steward-agent.md, "Steward
 * note"), pure over the write and the subject's standing read with no viewer: every refusal names
 * the field it is about and what the standing reads instead, so the writer corrects that one field.
 */

import type { Refusal } from '@forge/contracts/refusal';
import {
  basisFieldsOf,
  claimsOf,
  type ItemStanding,
  type StewardCite,
  type StewardClaims,
  type StewardNoteWrite,
} from '@forge/contracts/steward';

/** The group words a stuck note may not use, and the one a note on a standing that is not stuck may not. */
const OTHER_GROUP_WORDS = /\b(moving|planned|on track)\b/i;
const STUCK_WORD = /\bstuck\b/i;

const CLAIM_FIELDS = [
  'group',
  'waitingKind',
  'ref',
  'stuck',
  'stuckCode',
  'dueAt',
] as const satisfies readonly (keyof StewardClaims)[];

const shown = (v: unknown) => (v === null ? 'null' : JSON.stringify(v));

/** The claims a note on this standing must make, field by field. */
export const claimsOfStanding = (s: ItemStanding): StewardClaims =>
  claimsOf(basisFieldsOf({ ...s, waitingOn: s.waitingOn }));

/**
 * The refusals a write earns against `standing`, empty where it passes; `unknown` are the cites no
 * record of the project answers. Steps run in order and the first that refuses answers.
 */
export function vetNote(
  write: StewardNoteWrite,
  standing: ItemStanding,
  unknown: readonly StewardCite[],
): Refusal[] {
  const broken = write.lines.flatMap((line, i) =>
    /[\r\n]/.test(line)
      ? [
          {
            code: 'STEWARD_NOTE_TOO_LONG',
            path: `/lines/${i}`,
            detail: `line ${i + 1} holds a line break; a note is at most two lines, one sentence each.`,
          },
        ]
      : [],
  );
  if (broken.length > 0) return broken;
  if (unknown.length > 0) {
    return unknown.map((c) => ({
      code: 'STEWARD_NOTE_CITE_UNKNOWN',
      path: `/cites/${write.cites.indexOf(c)}`,
      detail: `${c.kind} ${c.ref} names no record of this project.`,
    }));
  }
  const ref = standing.waitingOn.ref;
  if (ref !== null && !write.cites.some((c) => c.ref === ref)) {
    return [
      {
        code: 'STEWARD_NOTE_CITE_MISSING',
        path: '/cites',
        detail: `the standing waits on ${ref}, and the note does not cite it.`,
      },
    ];
  }
  if (write.basis !== standing.basis) {
    return [
      {
        code: 'STEWARD_NOTE_STALE',
        path: '/basis',
        detail: `the standing moved since it was read: its basis is now ${standing.basis}.`,
      },
    ];
  }
  const want = claimsOfStanding(standing);
  const wrong = CLAIM_FIELDS.filter((f) => shown(write.claims[f]) !== shown(want[f]));
  if (wrong.length > 0) {
    return wrong.map((f) => ({
      code: 'STEWARD_NOTE_CONTRADICTS',
      path: `/claims/${f}`,
      detail: `the note claims ${f} ${shown(write.claims[f])}; the standing reads ${shown(want[f])}.`,
    }));
  }
  const stuck = standing.stuck !== null;
  return write.lines.flatMap((line, i) => {
    const word = stuck ? OTHER_GROUP_WORDS.exec(line)?.[0] : STUCK_WORD.exec(line)?.[0];
    if (!word) return [];
    return [
      {
        code: 'STEWARD_NOTE_CONTRADICTS',
        path: `/lines/${i}`,
        detail: stuck
          ? `line ${i + 1} says "${word}", and the standing reads stuck (${standing.stuck?.code}).`
          : `line ${i + 1} says "${word}", and the standing is not stuck.`,
      },
    ];
  });
}
