/**
 * A session a person starts or continues from the web runs each turn as that person (ISS-27): the
 * turn is handed only to a box that runs it under the token it carries, the token is minted for
 * the person whose message the turn carries — their role on the project, cut to what the box's
 * holder may do there — and it is revoked when the turn stops (migration 0324).
 */

import type { FailureCause } from '@forge/contracts/failure-causes';
import type { agentSessions } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import { forbidden } from '../middleware/route-errors.js';
import { type PermissionFacts, permissionRefusal, requireHeld } from '../permissions/index.js';
import { type ChatClient, noClaudeClient, resolveChatDevice } from './chat-device.js';
import { type DispatchChatTurnArgs, dispatchChatTurn } from './chat-turn.js';
import {
  mintSessionCredential,
  resolveSessionAuthority,
  revokeSessionCredential,
  type SessionAsker,
  type SessionAuthority,
} from './session-credential.js';

type AgentSessionRow = typeof agentSessions.$inferSelect;

/** A runner declaring this runs a follow-up turn (`agent:send`) under the token it carries, too. */
const FOLLOW_UP_CREDENTIAL_CAPABILITY = 'followUpCredential';

/** Bounds a turn whose stop is never written; a turn is revoked when it stops, and may run for hours. */
const INTERACTIVE_TURN_CREDENTIAL_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Why a session will not run as the person it would act as. `noRole` marks the one that is
 * transport: a person with no role on the project is answered 403, every other refusal in the
 * envelope under its declared status.
 */
export interface SessionRefusal {
  code: string;
  message: string;
  noRole?: true;
}

export const refusalError = (refusal: SessionRefusal) =>
  refusal.noRole
    ? forbidden(refusal.message)
    : new RefusalError(
        [{ code: refusal.code, path: '', detail: refusal.message }],
        'AGENT_SESSION_REFUSED',
      );

export const RUNNER_OUTDATED_REFUSAL: SessionRefusal = {
  code: 'RUNNER_OUTDATED',
  message:
    "The runner free to take this runs a forge-runner too old to act as you — it would act with its own owner's access instead, so nothing was dispatched. Update forge-runner on the box (`forge-runner update`) and try again.",
};

/**
 * A session on a paired box runs a shell in the box holder's checkout, which no Forge token
 * bounds, so a session takes project.write rather than handing a reader a read-only token.
 */
export function sessionRoleRefusal(
  facts: PermissionFacts | null | undefined,
): SessionRefusal | null {
  if (!facts?.role) {
    return {
      noRole: true,
      code: 'SESSION_NO_ROLE',
      message:
        'You hold no role on this project, so no agent session can run here as you. A project admin can add you.',
    };
  }
  const refusal = permissionRefusal(facts, 'project.write', 'running an agent session');
  return refusal ? { code: refusal.code, message: refusal.detail } : null;
}

export function assertMayRunSession(facts: PermissionFacts): void {
  requireHeld(facts, 'project.write', 'running an agent session');
}

/** Where only older runners are free a turn is refused, never handed to one that spends its holder's credential. */
export async function resolveInteractiveClient(
  session: Pick<AgentSessionRow, 'projectId' | 'deviceId' | 'metadata'>,
  opts: {
    overrideDeviceId?: string | null | undefined;
    scope: 'project' | 'session' | 'picked';
  },
): Promise<ChatClient> {
  const client = await resolveChatDevice(
    session,
    opts.overrideDeviceId,
    FOLLOW_UP_CREDENTIAL_CAPABILITY,
  );
  if (client.deviceId) return client;
  const anyBox = await resolveChatDevice(session, opts.overrideDeviceId);
  if (!anyBox.deviceId) throw noClaudeClient(opts.scope);
  throw refusalError(RUNNER_OUTDATED_REFUSAL);
}

/** Who a web turn acts as, read when the turn is dispatched. */
export type InteractiveAuthority = { deviceId: string; value: SessionAuthority };

/**
 * Whether `asker` may be acted as on `deviceId`, read now: a role that went away since the
 * session was opened, or since its schedule was saved, is not acted on.
 */
export async function readBoxAuthority(args: {
  deviceId: string;
  projectId: string;
  asker: SessionAsker;
}): Promise<
  { ok: true; authority: InteractiveAuthority } | { ok: false; refusal: SessionRefusal }
> {
  const roleRefusal = sessionRoleRefusal(
    await effectiveProjectRole(args.asker.userId, args.projectId),
  );
  if (roleRefusal) return { ok: false, refusal: roleRefusal };
  const got = await resolveSessionAuthority(args);
  if (!got.ok) return { ok: false, refusal: got.refusal };
  return { ok: true, authority: { deviceId: args.deviceId, value: got.value } };
}

export async function authorizeInteractiveTurn(args: {
  client: ChatClient;
  projectId: string;
  asker: SessionAsker;
}): Promise<InteractiveAuthority> {
  const deviceId = args.client.deviceId;
  if (!deviceId)
    throw new Error('authorizeInteractiveTurn: a remote turn reached here with no box');
  const read = await readBoxAuthority({ deviceId, projectId: args.projectId, asker: args.asker });
  if (!read.ok) throw refusalError(read.refusal);
  return read.authority;
}

/**
 * Dispatch a web turn under a token minted for the person it acts as. A dispatch that throws
 * revokes the token it minted, so no token outlives a turn that never reached a box.
 */
const MINT_STAGE = Symbol('mintStage');

/** Why an interactive turn never reached its box: the binding, the credential, or the hand-over. */
export function undeliveredTurnCause(
  err: unknown,
): Extract<FailureCause, 'checkout_unbound' | 'credential_mint_failed' | 'dispatch_failed'> {
  if (isRefusal(err, 'CHECKOUT_UNBOUND')) return 'checkout_unbound';
  return (err as { [MINT_STAGE]?: boolean } | null)?.[MINT_STAGE]
    ? 'credential_mint_failed'
    : 'dispatch_failed';
}

export async function dispatchInteractiveTurn(
  args: Omit<DispatchChatTurnArgs, 'credential'> & { authority: InteractiveAuthority },
): Promise<AgentSessionRow> {
  const { authority, ...turn } = args;
  if (turn.client.deviceId !== authority.deviceId) {
    throw new Error(
      `dispatchInteractiveTurn: session ${turn.session.id} was authorised for box ${authority.deviceId} and dispatched to ${turn.client.deviceId}; the token is tied to the box it was minted for`,
    );
  }
  const credential = await mintSessionCredential({
    sessionId: turn.session.id,
    deviceId: authority.deviceId,
    value: authority.value,
    ttlMs: INTERACTIVE_TURN_CREDENTIAL_TTL_MS,
  }).catch((err: unknown) => {
    if (err && typeof err === 'object') Object.assign(err, { [MINT_STAGE]: true });
    throw err;
  });
  try {
    return await dispatchChatTurn({ ...turn, credential });
  } catch (err) {
    await revokeSessionCredential(turn.session.id);
    throw err;
  }
}
