// A channel agent in owner mode runs confined (ISS-765, forge-core-61's switch gate before
// OrbitInternal switches): the box shows it its own clone of the repository, git directory included,
// and nothing else the box keeps. Its git and `gh` reach the repository with a credential core mints
// here for the project's own bound repository alone, asked for by the session's turn token; the box's
// SSH key, `gh` login, forge account and ops tools stay out of its view.

import { readProjectDocument } from '../project-config/index.js';
import type { CheckoutView } from '../agent-sessions/index.js';
import { sessionRowById } from '../agent-sessions/index.js';
import {
  gitHostsOfProject,
  mintGitCredentialForDevice,
} from '../integrations/source-host/index.js';
import { sessionCaller } from './access.js';
import type { SupportCaller } from './acts.js';
import { no, type Outcome } from './outcome.js';
import { agentMarkerOf } from './rooms.js';
import type { RoomRow } from './store.js';

/** The key of an owner-mode agent's own clone on its box: one per binding, as its session is. */
export const ownKeyOf = (room: Pick<RoomRow, 'bindingId'>): string => `own-${room.bindingId}`;

/**
 * The view an owner-mode agent's turn runs under: its own clone of the project's development branch
 * (`source.git.defaultBranch`), reaching the repository's git and API hosts. A project that declares
 * no development branch is refused by name: the agent never falls back to the box's own checkout.
 */
export async function ownViewOf(room: RoomRow): Promise<CheckoutView> {
  const held = await readProjectDocument(room.projectId);
  const git = (held?.document as { source?: { git?: { defaultBranch?: unknown } } } | undefined)
    ?.source?.git;
  const base = typeof git?.defaultBranch === 'string' ? git.defaultBranch : null;
  if (!base) {
    throw new Error(
      `support: [SUPPORT_OWNER_NO_BASE] project ${room.projectId} declares no development branch (\`source.git.defaultBranch\` in its project document), so its owner-mode channel agent has no branch to clone; it is not run on the box's own checkout instead`,
    );
  }
  return { mode: 'own', base, key: ownKeyOf(room), hosts: await gitHostsOfProject(room.projectId) };
}

export interface OwnerGitAsk {
  host: string;
  path: string;
}

export interface OwnerGitGrant {
  username: string;
  password: string;
  expiresAt: string;
}

/**
 * A git credential for the owner-mode agent asking, for its project's own bound repository and no
 * other: the turn token must be the session's own, the session in owner mode, and the repository the
 * one the project binds. GitHub's is an installation token narrowed to that repository, so the same
 * credential in `gh` reaches nothing else; a relayed host's is a relay ticket.
 */
export async function ownerGitCredential(
  caller: SupportCaller,
  ask: OwnerGitAsk,
): Promise<Outcome<OwnerGitGrant>> {
  const room = await sessionCaller(caller, { anyRoom: true });
  const session = room.sessionId ? await sessionRowById(room.sessionId) : null;
  if (room.kind !== 'agent' || agentMarkerOf(session?.metadata)?.ownerMode !== true) {
    return no(
      'SUPPORT_GIT_NOT_OWNER_MODE',
      '/host',
      "only a channel agent in owner mode is handed a git credential; this session works in the box's view of the checkout its grant shows it, and pushes nothing itself",
    );
  }
  if (!session?.deviceId) {
    return no(
      'SUPPORT_GIT_NOT_OWNER_MODE',
      '/host',
      'this session has not run on a box yet, so no box holds its clone',
    );
  }
  try {
    const grant = await mintGitCredentialForDevice({
      deviceId: session.deviceId,
      agentVersion: null,
      host: ask.host,
      path: ask.path,
      onlyProject: room.projectId,
    });
    return {
      ok: true,
      value: { username: grant.username, password: grant.password, expiresAt: grant.expiresAt },
    };
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404) {
      return no(
        'SUPPORT_GIT_NOT_OWN_REPO',
        '/path',
        `${ask.host}/${ask.path.replace(/\.git$/i, '')} is not the repository this project binds, and an owner-mode agent reaches its own project's repository and no other; nothing was minted`,
      );
    }
    throw err;
  }
}
