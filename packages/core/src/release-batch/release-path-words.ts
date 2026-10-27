// Where a release starts, said only by the doors a reader of this project actually has (ISS-1421).
// A project releases through a gate, ships nothing, or declares a release with no live target to
// land on (`gate.ts:resolveReleaseDeclaration`). On a gated project the issue's page offers Release
// now only to an issue a release would not hand straight back (`awaiting-release-banner.tsx`), so
// these sentences read the same shortfalls the page reads (`close-shortfall.ts`) before naming it.
// Every sentence here is short and whole: `release-path-words.test.ts` holds each to that.

import type { IssueStatus } from '../db/schema.js';
import { statusLabel } from '../issues/status-sets.js';
import {
  type CloseShortfall,
  rosterCloseShortfalls,
  shortfallSentence,
} from './close-shortfall.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';
import { projectPages } from './release-links.js';

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
  'This project releases nothing, so no release carries its issues.',
  "To release them, choose a shape that releases under Shape & release in the project's settings.",
];

const SHIPS_NOTHING_AT_GATE = [
  'This project releases nothing, so no release will carry it.',
  "To release it, choose a shape that releases under Shape & release in the project's settings.",
  'If work remains, reopen it instead.',
];

/** The pages a sentence may send its reader to, where this project's address could be read. */
export interface ReleaseDoors {
  /** Opens the project's Integrations settings at the section that adds a live deploy target. */
  addLiveTarget: string | null;
}

export const NO_DOORS: ReleaseDoors = { addLiveTarget: null };

// `integrations-tab.tsx:LIVE_DEPLOY_TARGET` is the web's name for that section.
const ADD_LIVE_TARGET_QUERY = 'tab=integrations&add=live-deploy-target';

export async function readReleaseDoors(
  projectId: string,
  path: ReleasePath,
): Promise<ReleaseDoors> {
  if (path !== 'no-live-target') return NO_DOORS;
  const pages = await projectPages(projectId);
  return pages ? { addLiveTarget: pages.settings(ADD_LIVE_TARGET_QUERY) } : NO_DOORS;
}

function noLiveTarget(doors: ReleaseDoors): string[] {
  return [
    'This project declares a release but has no live deploy target.',
    "No release can start until one is added in the project's Settings, on the Integrations tab.",
    'There, share a connection as Deploy target, with Live ticked.',
    ...(doors.addLiveTarget ? [`It opens at ${doors.addLiveTarget}.`] : []),
  ];
}

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
    'A release cannot close this issue yet.',
    ...holds.holds.flatMap((h) => [shortfallSentence(h.reason), h.clears]),
    'Release now appears on its page once that is done.',
  ];
}

/** The refusal's sentences on where a release starts, for a caller that may hold the API. */
export function releaseStartsFor(
  path: ReleasePath,
  projectId: string,
  from: IssueStatus,
  holds: GateHolds = NO_HOLDS,
  doors: ReleaseDoors = NO_DOORS,
): string[] {
  switch (path) {
    case 'gated':
      if (from !== RELEASE_GATE_STATUS) {
        return [
          `This issue is at ${statusLabel(from)}.`,
          `A release carries only issues at ${statusLabel(RELEASE_GATE_STATUS)}, so it must reach that first.`,
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
      return noLiveTarget(doors);
    case 'unread':
      return UNREAD_DECLARATION;
  }
}

/** What a person reading an issue returned to the gate can do next, with no route in it. */
export function nextAtGateFor(
  path: ReleasePath,
  holds: GateHolds = NO_HOLDS,
  doors: ReleaseDoors = NO_DOORS,
): string[] {
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
      return noLiveTarget(doors);
    case 'unread':
      return UNREAD_DECLARATION;
  }
}
