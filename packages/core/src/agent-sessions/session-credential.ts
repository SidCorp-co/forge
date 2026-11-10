/**
 * The token a session on a paired box answers a person's message under (ISS-17): minted FOR that
 * person, fenced to the project, tied to the box, cut to what the box's holder may do there, and
 * revoked when the session goes terminal. The runner puts it where the box's own would have gone.
 * A room's session acts under its own fenced account every turn, so it holds one token across its
 * turns instead (ISS-1202, `fencedSessionCredential`).
 */

import { readSessionAsker, type SessionAsker } from '@forge/contracts/agent-sessions';
import { and, eq, gt } from 'drizzle-orm';
import { mintPat, revokeLiveTokens } from '../credentials/pat.js';
import { turnTokenNameFor } from '../credentials/pat-format.js';
import { patIsLive } from '../credentials/pat-live.js';
import type { PatPermission } from '../credentials/pat-permissions.js';
import {
  AGENT_TURN_MENU,
  mintTurnCredential,
  type TurnAuthority,
  type TurnAuthorityRefusal,
} from '../credentials/turn-credential.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { findAvailableDeviceForProject } from '../lib/device-pool.js';
import { logger } from '../lib/logger.js';
import {
  heldPermissions,
  holds,
  type PermissionFacts,
  resolveTurnAuthority,
} from '../permissions/index.js';
import { resolveChatDevice } from './chat-device.js';
import { agentSessionsPorts } from './ports.js';

/** The capability a runner declares on its heartbeat when it runs a session under the token it is handed. */
const TURN_CREDENTIAL_CAPABILITY = 'turnCredential';

/** Bounds a session whose terminal write never arrives; a runner-hosted turn is minutes. */
const SESSION_CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000;

/** How long a room session's one token lives: held across its turns, never unbounded (ISS-1202). */
const ROOM_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A turn finding the room's token this close to its expiry is handed a fresh one: as long as a
 * per-turn token lives, so no turn handed the held token outlives it.
 */
const ROOM_CREDENTIAL_RENEW_MS = SESSION_CREDENTIAL_TTL_MS;

export { readSessionAsker, type SessionAsker };

export interface SessionAuthority {
  authority: TurnAuthority;
  menu: readonly PatPermission[];
}

/**
 * Whether a token carrying the asker's permissions may sit on a box whose holder holds `holder`: the
 * holder can read what it is handed, so every permission the token carries must be the holder's
 * too. A read-only token carries only the asker's reads.
 */
function holderCovers(holder: PermissionFacts, asker: PermissionFacts, readOnly: boolean): boolean {
  const theirs = new Set(heldPermissions(holder));
  return heldPermissions(asker)
    .filter((p) => !readOnly || p.endsWith('.read'))
    .every((p) => theirs.has(p));
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
  const holder = await agentSessionsPorts().deviceHolderUserId(args.deviceId);
  const none = { projectId: args.projectId, role: null, grants: [] };
  const holderFacts = (holder ? await effectiveProjectRole(holder, args.projectId) : null) ?? none;
  if (!holds(holderFacts, 'project.read')) {
    return {
      ok: false,
      refusal: {
        code: 'TURN_DEVICE_NO_ROLE',
        message:
          'I cannot answer this on a paired box: the box that is free is held by an account with no role on this project, so it may not act here for anyone.',
      },
    };
  }
  const askerFacts = (await effectiveProjectRole(args.asker.userId, args.projectId)) ?? none;
  const readOnly = !holds(holderFacts, 'project.write');
  if (!holderCovers(holderFacts, askerFacts, readOnly)) {
    return {
      ok: false,
      refusal: {
        code: 'TURN_DEVICE_OUTRANKED',
        message:
          "I will not run this on the paired box that is free: its holder holds a lower role on this project than the person it would act as, and a token handed to that box is readable by its holder. Run it on a box paired by someone holding the person's role.",
      },
    };
  }
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

/** The token a room's session holds, as core handed it: its plaintext lives in this process alone. */
interface HeldCredential {
  tokenId: string;
  plaintext: string;
  deviceId: string;
  userId: string;
  projectId: string;
  permissions: string;
  expiresAt: Date;
}

/**
 * Each room session's token, kept for its next turn. The database keeps only its hash, so a core
 * that restarted holds none, and the next turn mints a fresh one, revoking the old by name.
 */
const heldCredentials = new Map<string, HeldCredential>();

/**
 * The token a session that answers nobody in Forge acts under: minted for its own agent account,
 * fenced to its project, cut to the stated grant and tied to the box. A Rocket.Chat support group's
 * session is the one (REQ-75): its account is a member of nothing, so the grant reaches only the
 * routes that check for that session themselves. Every turn acts with that same authority, so the
 * session holds one token across its turns (ISS-1202): a turn is handed the one it holds while that
 * is live, for the same box, account, project and grant, and not within `ROOM_CREDENTIAL_RENEW_MS`
 * of its expiry; otherwise the old one is revoked by name and a fresh one minted. It is revoked when
 * the session truly ends: its rooms let go of it, it is archived or deleted (migration 0649).
 */
export async function fencedSessionCredential(args: {
  sessionId: string;
  deviceId: string;
  userId: string;
  projectId: string;
  permissions: readonly [PatPermission, ...PatPermission[]];
}): Promise<string> {
  const now = Date.now();
  for (const [id, h] of heldCredentials)
    if (h.expiresAt.getTime() <= now) heldCredentials.delete(id);
  const held = heldCredentials.get(args.sessionId);
  if (held && sameHolder(held, args) && (await stillHeld(held, args.sessionId, now))) {
    return held.plaintext;
  }
  heldCredentials.delete(args.sessionId);
  await revokeSessionCredential(args.sessionId);
  const expiresAt = new Date(now + ROOM_CREDENTIAL_TTL_MS);
  const minted = await mintPat({
    userId: args.userId,
    name: turnTokenNameFor(args.sessionId),
    permissions: args.permissions,
    projectIds: [args.projectId],
    scopes: ['read', 'write'],
    deviceId: args.deviceId,
    expiresAt,
  });
  heldCredentials.set(args.sessionId, {
    tokenId: minted.row.id,
    plaintext: minted.plaintext,
    deviceId: args.deviceId,
    userId: args.userId,
    projectId: args.projectId,
    permissions: grantKey(args.permissions),
    expiresAt,
  });
  return minted.plaintext;
}

const grantKey = (permissions: readonly string[]) => [...permissions].sort().join(' ');

function sameHolder(
  held: HeldCredential,
  args: { deviceId: string; userId: string; projectId: string; permissions: readonly string[] },
): boolean {
  return (
    held.deviceId === args.deviceId &&
    held.userId === args.userId &&
    held.projectId === args.projectId &&
    held.permissions === grantKey(args.permissions)
  );
}

/** Whether the held token is still the session's live one, and not near its expiry. */
async function stillHeld(held: HeldCredential, sessionId: string, now: number): Promise<boolean> {
  const [row] = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.id, held.tokenId),
        eq(personalAccessTokens.name, turnTokenNameFor(sessionId)),
        gt(personalAccessTokens.expiresAt, new Date(now + ROOM_CREDENTIAL_RENEW_MS)),
        patIsLive(),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The box a session's next turn runs on, among those that carry the token they are handed. */
export function turnCredentialChatDevice(
  session: Parameters<typeof resolveChatDevice>[0],
): ReturnType<typeof resolveChatDevice> {
  return resolveChatDevice(session, null, TURN_CREDENTIAL_CAPABILITY);
}

/** Revoke whatever token a session was handed; a session that was handed none revokes nothing. */
export async function revokeSessionCredential(sessionId: string): Promise<void> {
  try {
    await revokeLiveTokens({ name: turnTokenNameFor(sessionId) });
  } catch (err) {
    logger.error({ err, sessionId }, 'session credential: the turn token could not be revoked');
  }
}

/** What a room is told when the only free boxes run a runner that cannot carry the asker's token. */
const RUNNER_OUTDATED_REPLY: Record<'en' | 'vi', string> = {
  en: "The paired boxes free to answer this run a forge-runner too old to act as the person asking — it would act with its own owner's access instead, so I have not dispatched it. Update forge-runner on the box (`forge-runner update`) and ask again.",
  vi: 'Các máy đã ghép đang rảnh chạy forge-runner quá cũ, không thể hành động với quyền của người hỏi — nó sẽ dùng quyền của chủ máy, nên mình chưa gửi đi. Hãy cập nhật forge-runner trên máy (`forge-runner update`) rồi hỏi lại.', // i18n-allow: user-facing channel reply
};

/** What a room is told when an Agent turn was refused before a box took it, in the asker's language. */
export function agentRefusalText(
  started: {
    reason: string;
    message?: string | undefined;
  },
  language: 'en' | 'vi' = 'en',
): string {
  if (started.reason === 'runner-outdated') return RUNNER_OUTDATED_REPLY[language];
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
