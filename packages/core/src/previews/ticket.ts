// The two credentials a preview host reads (BC-4; Coder's smuggled app key,
// coderd/workspaceapps/token.go): a one-minute ticket a Forge session mints for one preview, spent
// once at `/__forge_preview/enter`, and the viewer cookie it is swapped for, host-only on the preview
// host. Both are HS256 JWTs under JWT_SECRET, each with its own issuer so neither verifies as the
// other or as a session token (`auth/oauth/state.ts` signs the same way).

import { randomUUID } from 'node:crypto';
import { PREVIEW_LIMITS } from '@forge/contracts/preview';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../lib/env.js';

const ALG = 'HS256';
const TICKET_ISSUER = 'forge.preview.ticket';
const VIEWER_ISSUER = 'forge.preview.viewer';

let cachedKey: Uint8Array | null = null;
const key = (): Uint8Array => {
  cachedKey ??= new TextEncoder().encode(env.JWT_SECRET);
  return cachedKey;
};

export interface PreviewGrant {
  previewId: string;
  userId: string;
}

/** Tickets spent, by id, until they would have expired anyway: a ticket enters once. */
const spent = new Map<string, number>();

function forgetExpired(now: number): void {
  for (const [jti, expiresAt] of spent) if (expiresAt <= now) spent.delete(jti);
}

export async function signTicket(grant: PreviewGrant, now = Date.now()) {
  const expiresAt = new Date(now + PREVIEW_LIMITS.ticketSeconds * 1000);
  const token = await new SignJWT({ pid: grant.previewId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(TICKET_ISSUER)
    .setSubject(grant.userId)
    .setJti(randomUUID())
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
  return { token, expiresAt };
}

/**
 * The grant a ticket carries, once: a second presentation, an expired one, or one signed for
 * anything else answers null.
 */
export async function spendTicket(token: string, now = Date.now()): Promise<PreviewGrant | null> {
  const grant = await read(token, TICKET_ISSUER, now);
  if (grant === null || grant.jti === '') return null;
  forgetExpired(now);
  if (spent.has(grant.jti)) return null;
  spent.set(grant.jti, grant.expiresAt);
  return { previewId: grant.previewId, userId: grant.userId };
}

export function signViewer(grant: PreviewGrant, now = Date.now()): Promise<string> {
  return new SignJWT({ pid: grant.previewId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(VIEWER_ISSUER)
    .setSubject(grant.userId)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + PREVIEW_LIMITS.viewerSeconds)
    .sign(key());
}

export async function readViewer(token: string, now = Date.now()): Promise<PreviewGrant | null> {
  const grant = await read(token, VIEWER_ISSUER, now);
  return grant && { previewId: grant.previewId, userId: grant.userId };
}

async function read(token: string, issuer: string, now: number) {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer,
      algorithms: [ALG],
      currentDate: new Date(now),
    });
    if (typeof payload.pid !== 'string' || typeof payload.sub !== 'string') return null;
    return {
      previewId: payload.pid,
      userId: payload.sub,
      jti: payload.jti ?? '',
      expiresAt: (payload.exp ?? 0) * 1000,
    };
  } catch {
    return null;
  }
}
