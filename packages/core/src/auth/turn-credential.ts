/**
 * The authority a turn acts under: the person whose message it answers, as that person, and no wider.
 *
 * A turn never holds a principal of its own. It resolves the person, refuses by name where the
 * person cannot be acted as, and mints a short-lived token FOR that person whose grant is the
 * intersection of what the turn's tools need and what the person's own credential grants. Every
 * tool call then runs under a real token, checked by the door that token would meet (ISS-17).
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { personalAccessTokens, users } from '../db/schema.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { logger } from '../logger.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import { mintPat, revokePat } from './pat.js';
import { turnTokenDefaultName } from './pat-format.js';
import { patIsLive } from './pat-live.js';
import {
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_GROUPS,
  PAT_PERMISSION_NAMES,
  type PatPermission,
  patGrantCovers,
} from './pat-permissions.js';
import { patPrincipalOf } from './pat-principal.js';

/** What an in-process chat turn's tools reach: the tracker verbs the `forge` CLI runs, and the reads beside them. */
export const CHAT_TURN_MENU: readonly PatPermission[] = [
  'issues:read',
  'issues:write',
  'projects:read',
  'projects:write',
  'knowledge:read',
  'knowledge:write',
  'questions:read',
  'pipeline:read',
];

/** What a session on a paired box reaches: every permission a project-fenced token may hold. */
export const AGENT_TURN_MENU: readonly PatPermission[] = PAT_PERMISSION_NAMES.filter(
  (name) => PAT_PERMISSION_GROUPS[name].reach === 'project',
);

export type TurnAuthorityRefusalCode =
  | 'TURN_NO_ROLE'
  | 'TURN_TOKEN_NOT_LIVE'
  | 'TURN_TOKEN_FENCED'
  | 'TURN_GRANT_EMPTY'
  | 'TURN_DEVICE_NO_ROLE'
  | 'TURN_DEVICE_OUTRANKED';

/** Why a turn will not act as the person, in words the room is shown. */
export interface TurnAuthorityRefusal {
  code: TurnAuthorityRefusalCode;
  message: string;
}

export class TurnAuthorityRefused extends Error {
  readonly code: TurnAuthorityRefusalCode;
  constructor(refusal: TurnAuthorityRefusal) {
    super(refusal.message);
    this.name = 'TurnAuthorityRefused';
    this.code = refusal.code;
  }
}

/** The person a turn acts as, and the bounds their own credential sets. */
export interface TurnAuthority {
  userId: string;
  projectId: string;
  /** The token the person reached Forge with; null for a browser session or a linked chat account. */
  viaTokenId: string | null;
  /** That token's grant, null where the person's project role is the whole bound. */
  grant: readonly string[] | null;
  fence: readonly string[] | null;
  scopes: readonly string[];
  grantEpoch: number;
}

export type TurnAuthorityOutcome =
  | { ok: true; authority: TurnAuthority }
  | { ok: false; refusal: TurnAuthorityRefusal };

const refuse = (code: TurnAuthorityRefusalCode, message: string): TurnAuthorityOutcome => ({
  ok: false,
  refusal: { code, message },
});

/**
 * Resolve whether `userId` may be acted as on `projectId` right now, bounded by `viaTokenId`
 * when the person reached Forge with a token. Read at the moment the turn acts, not when the
 * message arrived: a role or a token that went away since is not acted on.
 */
export async function resolveTurnAuthority(args: {
  userId: string;
  projectId: string;
  viaTokenId: string | null;
}): Promise<TurnAuthorityOutcome> {
  const access = await effectiveProjectRole(args.userId, args.projectId);
  if (!projectRoleAtLeast(access?.role ?? null, 'viewer')) {
    return refuse(
      'TURN_NO_ROLE',
      'I cannot act on this: the person asking holds no role on this project, so there is nobody here I may act as. A project admin can add them.',
    );
  }

  let grant: readonly string[] | null = null;
  let fence: readonly string[] | null = null;
  let scopes: readonly string[] = ['read', 'write'];
  let grantEpoch = PAT_GRANT_EPOCH;
  if (args.viaTokenId) {
    const [row] = await db
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.id, args.viaTokenId),
          eq(personalAccessTokens.userId, args.userId),
          patIsLive(),
        ),
      )
      .limit(1);
    if (!row) {
      return refuse(
        'TURN_TOKEN_NOT_LIVE',
        'I will not act on this: the access token it was sent with has been revoked or has expired since, and a message is acted on with the authority it arrived with. Send it again signed in, or with a live token.',
      );
    }
    const tokenFence = row.boundProjectId ? [row.boundProjectId] : (row.projectIds ?? null);
    if (tokenFence !== null && !tokenFence.includes(args.projectId)) {
      return refuse(
        'TURN_TOKEN_FENCED',
        'I will not act on this: the access token it was sent with does not reach this project, and acting here would reach past it.',
      );
    }
    grant = row.permissions ?? null;
    fence = tokenFence;
    scopes = row.scopes;
    grantEpoch = row.grantEpoch;
  }

  return {
    ok: true,
    authority: {
      userId: args.userId,
      projectId: args.projectId,
      viaTokenId: args.viaTokenId,
      grant,
      fence,
      scopes,
      grantEpoch,
    },
  };
}

/** A token minted for one turn: its plaintext for a child process, its principal for in-process tools. */
export interface TurnCredential {
  readonly token: string;
  readonly tokenId: string;
  readonly principal: PatPrincipal;
  /** The person's own grant, for a tool whose REST equivalent the minted token cannot hold. */
  readonly grant: readonly string[] | null;
  readonly fence: readonly string[] | null;
  readonly revoke: () => Promise<void>;
}

/**
 * Mint the turn's token. It is fenced to the project, expires on its own, and is revoked by the
 * caller when the turn ends; `deviceId` ties it to the box it was handed to, so unpairing the box
 * takes it with it.
 */
export async function mintTurnCredential(args: {
  authority: TurnAuthority;
  /** What the turn's tools reach; the token is granted this, cut to the person's own grant. */
  menu: readonly PatPermission[];
  /** A name the token is found by; unique among the person's live tokens. */
  name?: string;
  ttlMs: number;
  deviceId?: string | null;
}): Promise<TurnCredential> {
  const { authority } = args;
  const granted = args.menu.filter((p) => patGrantCovers(authority.grant, p));
  if (granted.length === 0) {
    throw new TurnAuthorityRefused({
      code: 'TURN_GRANT_EMPTY',
      message: `I cannot act on this: the access token it was sent with grants none of what my tools use (${args.menu.join(', ')}).`,
    });
  }
  const [owner] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, authority.userId))
    .limit(1);
  if (!owner) throw new Error(`turn credential: user ${authority.userId} does not exist`);
  const scopes = ['read', 'write'].filter((s) => authority.scopes.includes(s));
  const minted = await mintPat({
    userId: authority.userId,
    name: args.name ?? turnTokenDefaultName(new Date(), randomBytes(4).toString('hex')),
    scopes,
    permissions: granted,
    projectIds: [authority.projectId],
    boundProjectId: authority.projectId,
    grantEpoch: Math.min(authority.grantEpoch, PAT_GRANT_EPOCH),
    deviceId: args.deviceId ?? null,
    expiresAt: new Date(Date.now() + args.ttlMs),
  });
  const tokenId = minted.row.id;
  return {
    token: minted.plaintext,
    tokenId,
    principal: patPrincipalOf({ row: minted.row, ownerKind: owner.kind }),
    grant: authority.grant,
    fence: authority.fence,
    revoke: async () => {
      await revokePat(tokenId, authority.userId).catch((err: unknown) =>
        logger.error({ err, tokenId }, 'turn credential: the turn token could not be revoked'),
      );
    },
  };
}
