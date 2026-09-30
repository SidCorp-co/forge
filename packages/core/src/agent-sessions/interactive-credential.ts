/**
 * A session a person starts or continues from the web runs each turn as that person (ISS-27): the
 * turn is handed only to a box that runs it under the token it carries, the token is minted for
 * the person whose message the turn carries — their role on the project, cut to what the box's
 * holder may do there — and it is revoked when the turn stops (migration 0324).
 */

import { HTTPException } from 'hono/http-exception';
import type { agentSessions, ProjectMemberRole } from '../db/schema.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import {
  type ChatClient,
  type DispatchChatTurnArgs,
  dispatchChatTurn,
  noClaudeClient,
  resolveChatDevice,
} from './chat-turn.js';
import {
  mintSessionCredential,
  resolveSessionAuthority,
  revokeSessionCredential,
  type SessionAsker,
  type SessionAuthority,
} from './session-credential.js';

type AgentSessionRow = typeof agentSessions.$inferSelect;

/**
 * The capability a runner declares when a follow-up turn (`agent:send`) runs under the token it
 * carries as well as a first one: a web session's every turn carries its own.
 */
export const FOLLOW_UP_CREDENTIAL_CAPABILITY = 'followUpCredential';

/** Bounds a turn whose stop is never written; a turn is revoked when it stops, and may run for hours. */
const INTERACTIVE_TURN_CREDENTIAL_TTL_MS = 8 * 60 * 60 * 1000;

const refuse = (status: 403 | 409, code: string, message: string) =>
  new HTTPException(status, { message, cause: { code } });

/**
 * A session on a paired box runs a shell in the box holder's checkout, which no Forge token
 * bounds, so a viewer is refused one rather than handed a read-only token.
 */
export function assertMayRunSession(role: ProjectMemberRole | null | undefined): void {
  if (!role) {
    throw refuse(
      403,
      'SESSION_NO_ROLE',
      'You hold no role on this project, so no agent session can run here as you. A project admin can add you.',
    );
  }
  if (!projectRoleAtLeast(role, 'member')) {
    throw refuse(
      403,
      'SESSION_VIEWER',
      "A viewer cannot run an agent session: it runs a shell in a paired box's checkout, which a read-only Forge token does not bound. A project admin can make you a member.",
    );
  }
}

/**
 * The box a web turn goes to: one whose runner runs every turn under the token it is handed.
 * Where only older runners are free the turn is refused by name rather than handed to one that
 * would spend its holder's credential.
 */
export async function resolveInteractiveClient(
  session: Pick<AgentSessionRow, 'projectId' | 'deviceId' | 'metadata'>,
  opts: {
    origin?: string | null | undefined;
    overrideDeviceId?: string | null | undefined;
    scope: 'project' | 'session' | 'picked';
  },
): Promise<ChatClient> {
  const client = await resolveChatDevice(
    session,
    opts.origin,
    opts.overrideDeviceId,
    FOLLOW_UP_CREDENTIAL_CAPABILITY,
  );
  if (client.isLocal || client.deviceId) return client;
  const anyBox = await resolveChatDevice(session, opts.origin, opts.overrideDeviceId);
  if (!anyBox.deviceId) throw noClaudeClient(opts.scope);
  throw refuse(
    409,
    'RUNNER_OUTDATED',
    "The runner free to take this runs a forge-runner too old to act as you — it would act with its own owner's access instead, so nothing was dispatched. Update forge-runner on the box (`forge-runner update`) and try again.",
  );
}

/** Who a web turn acts as, read when the turn is dispatched; `null` for a local turn, which no box runs. */
export type InteractiveAuthority = { deviceId: string; value: SessionAuthority } | null;

/**
 * Whether `asker` may be acted as on the box `client` names, read now: a role that went away since
 * the session was opened is not acted on.
 */
export async function authorizeInteractiveTurn(args: {
  client: ChatClient;
  projectId: string;
  asker: SessionAsker;
}): Promise<InteractiveAuthority> {
  if (args.client.isLocal) return null;
  const deviceId = args.client.deviceId;
  if (!deviceId)
    throw new Error('authorizeInteractiveTurn: a remote turn reached here with no box');
  assertMayRunSession((await effectiveProjectRole(args.asker.userId, args.projectId))?.role);
  const got = await resolveSessionAuthority({
    asker: args.asker,
    projectId: args.projectId,
    deviceId,
  });
  if (!got.ok) throw refuse(403, got.refusal.code, got.refusal.message);
  return { deviceId, value: got.value };
}

/**
 * Dispatch a web turn under a token minted for the person it acts as. A dispatch that throws
 * revokes the token it minted, so no token outlives a turn that never reached a box.
 */
export async function dispatchInteractiveTurn(
  args: Omit<DispatchChatTurnArgs, 'credential'> & { authority: InteractiveAuthority },
): Promise<AgentSessionRow> {
  const { authority, ...turn } = args;
  if (!authority) {
    if (!turn.client.isLocal) {
      throw new Error(
        `dispatchInteractiveTurn: session ${turn.session.id} is dispatched to a box with no authority to act under`,
      );
    }
    return dispatchChatTurn(turn);
  }
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
  });
  try {
    return await dispatchChatTurn({ ...turn, credential });
  } catch (err) {
    await revokeSessionCredential(turn.session.id);
    throw err;
  }
}
