/**
 * The token a session on a paired box answers a person's message under (ISS-17): minted FOR that
 * person, fenced to the project, tied to the box, cut to what the box's holder may do there, and
 * revoked when the session goes terminal. The runner puts it where the box's own would have gone.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { turnTokenNameFor } from '../auth/pat-format.js';
import type { PatPermission } from '../auth/pat-permissions.js';
import {
  AGENT_TURN_MENU,
  mintTurnCredential,
  resolveTurnAuthority,
  type TurnAuthority,
  type TurnAuthorityRefusal,
} from '../auth/turn-credential.js';
import { db } from '../db/client.js';
import { type ProjectMemberRole, personalAccessTokens } from '../db/schema.js';
import { deviceHolderUserId } from '../devices/workspace-credential.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { findAvailableDeviceForProject } from '../lib/device-pool.js';
import { logger } from '../logger.js';

/** The capability a runner declares on its heartbeat when it runs a session under the token it is handed. */
export const TURN_CREDENTIAL_CAPABILITY = 'turnCredential';

/** Bounds a session whose terminal write never arrives; a runner-hosted turn is minutes. */
const SESSION_CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000;

/** Who asked, as a session's metadata carries it so a failover can mint again. */
export interface SessionAsker {
  userId: string;
  viaTokenId: string | null;
}

export function readSessionAsker(raw: unknown): SessionAsker | null {
  const m = raw as { userId?: unknown; viaTokenId?: unknown } | null;
  if (!m || typeof m.userId !== 'string') return null;
  return { userId: m.userId, viaTokenId: typeof m.viaTokenId === 'string' ? m.viaTokenId : null };
}

export interface SessionAuthority {
  authority: TurnAuthority;
  menu: readonly PatPermission[];
}

/**
 * The highest role a token handed to a box held at `holderRole` may carry. A viewer's box is
 * handed read-only tokens, and a member's token cut to read reaches what a viewer reads; nothing
 * cuts an admin's token to a lower role, so an asker above the ceiling is refused rather than
 * handed to a box whose holder could read the token and act above their own role.
 */
function holderCeiling(holderRole: ProjectMemberRole): ProjectMemberRole {
  return holderRole === 'viewer' ? 'member' : holderRole;
}

/**
 * Whether `asker` may be acted as on `deviceId` for this project, and with what: their own
 * authority, read now, intersected with what the box's holder may do on the project — a box
 * whose holder may only read is handed a token that only reads, and a person who outranks the
 * box's holder is refused.
 */
export async function resolveSessionAuthority(args: {
  asker: SessionAsker;
  projectId: string;
  deviceId: string;
}): Promise<{ ok: true; value: SessionAuthority } | { ok: false; refusal: TurnAuthorityRefusal }> {
  const resolved = await resolveTurnAuthority({
    userId: args.asker.userId,
    projectId: args.projectId,
    viaTokenId: args.asker.viaTokenId,
  });
  if (!resolved.ok) return resolved;
  const holder = await deviceHolderUserId(args.deviceId);
  const holderRole = holder
    ? ((await effectiveProjectRole(holder, args.projectId))?.role ?? null)
    : null;
  if (!projectRoleAtLeast(holderRole, 'viewer')) {
    return {
      ok: false,
      refusal: {
        code: 'TURN_DEVICE_NO_ROLE',
        message:
          'I cannot answer this on a paired box: the box that is free is held by an account with no role on this project, so it may not act here for anyone.',
      },
    };
  }
  const askerRole = (await effectiveProjectRole(args.asker.userId, args.projectId))?.role ?? null;
  if (holderRole && !projectRoleAtLeast(holderCeiling(holderRole), askerRole ?? 'viewer')) {
    return {
      ok: false,
      refusal: {
        code: 'TURN_DEVICE_OUTRANKED',
        message:
          "I will not run this on the paired box that is free: its holder holds a lower role on this project than the person it would act as, and a token handed to that box is readable by its holder. Run it on a box paired by someone holding the person's role.",
      },
    };
  }
  const readOnly = !projectRoleAtLeast(holderRole, 'member');
  const authority: TurnAuthority = readOnly
    ? { ...resolved.authority, scopes: resolved.authority.scopes.filter((s) => s === 'read') }
    : resolved.authority;
  const menu = readOnly ? AGENT_TURN_MENU.filter((p) => p.endsWith(':read')) : AGENT_TURN_MENU;
  return { ok: true, value: { authority, menu } };
}

/**
 * Mint the session's token, superseding any the session still holds: one left by a turn whose
 * dispatch never completed would otherwise take the name. Its plaintext exists only here and in
 * the frame it is sent in.
 */
export async function mintSessionCredential(args: {
  sessionId: string;
  deviceId: string;
  value: SessionAuthority;
  ttlMs?: number;
}): Promise<string> {
  await revokeSessionCredential(args.sessionId);
  const minted = await mintTurnCredential({
    authority: args.value.authority,
    menu: args.value.menu,
    name: turnTokenNameFor(args.sessionId),
    ttlMs: args.ttlMs ?? SESSION_CREDENTIAL_TTL_MS,
    deviceId: args.deviceId,
  });
  return minted.token;
}

/** Revoke whatever token a session was handed; a session that was handed none revokes nothing. */
export async function revokeSessionCredential(sessionId: string): Promise<void> {
  try {
    await db
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(personalAccessTokens.name, turnTokenNameFor(sessionId)),
          isNull(personalAccessTokens.revokedAt),
        ),
      );
  } catch (err) {
    logger.error({ err, sessionId }, 'session credential: the turn token could not be revoked');
  }
}

/** What a room is told when the only free boxes run a runner that cannot carry the asker's token. */
export const RUNNER_OUTDATED_REPLY =
  "The paired boxes free to answer this run a forge-runner too old to act as the person asking — it would act with its own owner's access instead, so I have not dispatched it. Update forge-runner on the box (`forge-runner update`) and ask again.";

/** What a room is told when an Agent turn was refused before a box took it. */
export function agentRefusalText(started: {
  reason: string;
  message?: string | undefined;
}): string {
  if (started.reason === 'runner-outdated') return RUNNER_OUTDATED_REPLY;
  if (!started.message) {
    throw new Error(
      `conversation-agent: an Agent turn was refused (${started.reason}) with no sentence to tell the room`,
    );
  }
  return started.message;
}

/** A box that did not declare `TURN_CREDENTIAL_CAPABILITY` would spend its owner's credential. */
export function pickTurnCredentialDevice(
  projectId: string,
  excludeDeviceIds: string[] = [],
): Promise<string | null> {
  return findAvailableDeviceForProject(projectId, {
    excludeDeviceIds,
    requireCapability: TURN_CREDENTIAL_CAPABILITY,
  });
}

export async function noTurnCredentialDeviceReason(
  projectId: string,
  excludeDeviceIds: string[] = [],
): Promise<'no-device' | 'runner-outdated'> {
  return (await findAvailableDeviceForProject(projectId, { excludeDeviceIds }))
    ? 'runner-outdated'
    : 'no-device';
}
