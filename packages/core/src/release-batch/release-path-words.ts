// Where a release starts, said only by the doors a reader of this project actually has (ISS-1421).
// A project releases through a gate, ships nothing, or declares a release with no live target to
// land on (`gate.ts:resolveReleaseDeclaration`). On a gated project the issue's page offers Release
// now only to an issue a release would not hand straight back (`awaiting-release-banner.tsx`), so
// these sentences read the same shortfalls the page reads (`close-shortfall.ts`) before naming it.
// Every sentence here is short and whole: `release-path-words.test.ts` holds each to that.

import type { IssueStatus } from '../db/schema.js';
import { statusForCaller } from '../issues/status-sets.js';
import { type CloseShortfall, rosterCloseShortfalls } from './close-shortfall.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';

/** How this project releases, as the sentences below choose by. */
export type ReleasePath = 'gated' | 'ships-nothing' | 'no-live-target' | 'unread';

export async function readReleasePath(projectId: string): Promise<ReleasePath> {
  try {
    const decl = await resolveReleaseDeclaration(projectId);
    if (!decl) return 'unread';
    if (decl.kind === 'gated') return 'gated';
    return decl.kind === 'no-release' ? 'ships-nothing' : 'no-live-target';
  } catch {
    return 'unread';
  }
}

export type GateHolds =
  | { kind: 'read'; holds: ReadonlyArray<Pick<CloseShortfall, 'reason' | 'clears'>> }
  | { kind: 'unread' };

export const NO_HOLDS: GateHolds = { kind: 'read', holds: [] };

export async function readGateHolds(projectId: string, issueId: string): Promise<GateHolds> {
  try {
    const found = await rosterCloseShortfalls(projectId, [issueId]);
    return { kind: 'read', holds: found.get(issueId) ?? [] };
  } catch {
    return { kind: 'unread' };
  }
}

const SHIPS_NOTHING_REFUSAL = [
  'This project ships nothing, so no release carries its issues.',
  "To release them, choose a shape that releases under Shape & release in the project's settings.",
];

const SHIPS_NOTHING_AT_GATE = [
  'This project ships nothing, so no release will carry it.',
  "To release it, choose a shape that releases under Shape & release in the project's settings.",
  'If work remains, reopen it instead.',
];

const NO_LIVE_TARGET = [
  'This project declares a release but has no live deploy target.',
  "No release can start until one is added on the project's integrations screen.",
];

const UNREAD_DECLARATION = [
  "This project's release settings could not be read, so this names no way to start a release.",
];

/** What holds the issue back and what clears it, or `null` where nothing does. */
function heldBack(holds: GateHolds): string[] | null {
  if (holds.kind === 'unread') {
    return [
      'Whether a release would close this issue could not be read.',
      'Its page offers Release now only when nothing holds it back.',
    ];
  }
  if (holds.holds.length === 0) return null;
  return [
    `A release cannot close this issue yet: ${holds.holds.map((h) => h.reason).join('; ')}.`,
    ...holds.holds.map((h) => h.clears),
    'Release now appears on its page once that is done.',
  ];
}

/** The refusal's sentences on where a release starts, for a caller that may hold the API. */
export function releaseStartsFor(
  path: ReleasePath,
  projectId: string,
  from: IssueStatus,
  holds: GateHolds = NO_HOLDS,
): string[] {
  switch (path) {
    case 'gated':
      if (from !== RELEASE_GATE_STATUS) {
        return [
          `This issue is at ${statusForCaller(from)}.`,
          `A release carries only issues at ${statusForCaller(RELEASE_GATE_STATUS)}, so it must reach that first.`,
        ];
      }
      return (
        heldBack(holds) ?? [
          "Start one with Release now on this issue's page or at the release gate.",
          `An API caller can also POST /api/projects/${projectId}/release-batches with this issue in \`issueIds\`.`,
        ]
      );
    case 'ships-nothing':
      return SHIPS_NOTHING_REFUSAL;
    case 'no-live-target':
      return NO_LIVE_TARGET;
    case 'unread':
      return UNREAD_DECLARATION;
  }
}

/** What a person reading an issue returned to the gate can do next, with no route in it. */
export function nextAtGateFor(path: ReleasePath, holds: GateHolds = NO_HOLDS): string[] {
  switch (path) {
    case 'gated':
      return (
        heldBack(holds) ?? [
          'Release now on this page, or at the release gate on the issues list, starts a release.',
        ]
      );
    case 'ships-nothing':
      return SHIPS_NOTHING_AT_GATE;
    case 'no-live-target':
      return NO_LIVE_TARGET;
    case 'unread':
      return UNREAD_DECLARATION;
  }
}
