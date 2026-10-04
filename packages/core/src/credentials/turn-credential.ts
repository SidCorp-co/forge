/**
 * The authority a turn acts under: the person whose message it answers, as that person, and no wider.
 *
 * A turn never holds a principal of its own. It resolves the person, refuses by name where the
 * person cannot be acted as, and mints a short-lived token FOR that person whose grant is the
 * intersection of what the turn's tools need and what the person's own credential grants. Every
 * tool call then runs under a real token, checked by the door that token would meet (ISS-17).
 */

import { randomBytes } from 'node:crypto';
import { TURN_AUTHORITY_REFUSAL_CODES, type TurnAuthorityRefusalCode } from '@forge/contracts/auth';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { personalAccessTokens, users } from '../db/schema.js';
import { isRefusal, refuser } from '../lib/refusal.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import { logger } from '../observability/logger.js';
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

/** Why a turn will not act as the person, in words the room is shown. */
export interface TurnAuthorityRefusal {
  code: TurnAuthorityRefusalCode;
  message: string;
}

const turnRefused = refuser<TurnAuthorityRefusalCode>('TURN_GRANT_EMPTY');

/** A thrown turn-authority refusal and its sentence, or null for anything else. */
export function turnAuthorityRefusalOf(
  err: unknown,
): { code: TurnAuthorityRefusalCode; message: string } | null {
  if (!isRefusal(err)) return null;
  const hit = err.refusals.find((r) =>
    (TURN_AUTHORITY_REFUSAL_CODES as readonly string[]).includes(r.code),
  );
  return hit ? { code: hit.code as TurnAuthorityRefusalCode, message: hit.detail } : null;
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

/** The person's own token a turn is bounded by, or null where it was revoked or has expired since. */
export async function liveTurnToken(tokenId: string, userId: string) {
  const [row] = await db
    .select()
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.id, tokenId),
        eq(personalAccessTokens.userId, userId),
        patIsLive(),
      ),
    )
    .limit(1);
  return row ?? null;
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
    throw turnRefused(
      'TURN_GRANT_EMPTY',
      `I cannot act on this: the access token it was sent with grants none of what my tools use (${args.menu.join(', ')}).`,
    );
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
