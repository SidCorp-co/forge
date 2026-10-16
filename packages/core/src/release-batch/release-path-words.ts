// Where a release starts, said only by the doors a reader of this project actually has (ISS-1421
// round 2). A project releases through a gate, ships nothing, or declares a release with no live
// target to land on (`gate.ts:resolveReleaseDeclaration`), and a sentence naming Release now on a
// project with no gate, or to an issue not waiting at it, sends its reader to a button that is not
// there.

import type { IssueStatus } from '../db/schema.js';
import { statusForCaller } from '../issues/status-sets.js';
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

const SHIPS_NOTHING =
  'This project ships nothing, so no release ever carries its issues: one can only once the ' +
  "project's Shape & release setting chooses a shape that releases.";

const NO_LIVE_TARGET =
  'This project declares a release but has no live deploy target, so no release can start until ' +
  'one is added on its integrations screen.';

/** The refusal's sentence on where a release starts, for a caller that may hold the API. */
export function releaseStartsFor(path: ReleasePath, projectId: string, from: IssueStatus): string {
  switch (path) {
    case 'gated':
      return from === RELEASE_GATE_STATUS
        ? "Start one with Release now on this issue's page or at the release gate, or with " +
            `POST /api/projects/${projectId}/release-batches naming this issue in \`issueIds\`.`
        : `This issue is at ${statusForCaller(from)}, so it must reach ` +
            `${statusForCaller(RELEASE_GATE_STATUS)} before a release can carry it.`;
    case 'ships-nothing':
      return SHIPS_NOTHING;
    case 'no-live-target':
      return NO_LIVE_TARGET;
    case 'unread':
      return "This project's release declaration could not be read, so no door is named here.";
  }
}

/** What a person reading an issue returned to the gate can do next, with no route in it. */
export function nextAtGateFor(path: ReleasePath): string {
  switch (path) {
    case 'gated':
      return (
        'Release now on this page, or at the release gate on the issues list, starts a release ' +
        'that carries it.'
      );
    case 'ships-nothing':
      return (
        'This project ships nothing, so no release will carry it: choose a shape that releases ' +
        "under Shape & release in the project's settings to release it, or reopen it if work remains."
      );
    case 'no-live-target':
      return NO_LIVE_TARGET;
    case 'unread':
      return "This project's release declaration could not be read, so no next step is named here.";
  }
}
