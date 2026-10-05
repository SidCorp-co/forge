import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { env } from './env.js';
import { digestToken } from './token-digest.js';

/**
 * Which pending invitation a call names: the emailed `token`, or the stored digest `ref` the
 * signed-in invitee's own inbox lists. A `ref` is only a handle; every use of one also requires
 * the invitee's email to match.
 */
export type InvitationKey = { token: string } | { ref: string };

const INVITATION_REF = /^[0-9a-f]{64}$/;

export const badRequest = (code: string, message: string) =>
  new HTTPException(400, { message, cause: { code } });

export const gone = (code: string, message: string) =>
  new HTTPException(410, { message, cause: { code } });

export const notFound = (code: string, message: string) =>
  new HTTPException(404, { message, cause: { code } });

/** The emailed token from `/:token/...`, or the inbox's digest ref from `/ref/:ref/...`, refused by name when malformed. */
export function invitationKeyOf(params: Record<string, string>): InvitationKey {
  if (params.ref !== undefined) {
    if (!INVITATION_REF.test(params.ref)) {
      throw badRequest(
        'INVALID_INVITATION_REF',
        'an invitation ref is the 64-character hex digest GET /api/invitations/pending lists',
      );
    }
    return { ref: params.ref };
  }
  if (!params.token) throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  return { token: params.token };
}

export function invitationDigest(key: InvitationKey): string {
  return 'token' in key ? digestToken(key.token) : key.ref;
}

/** How long a project or org invitation stays open. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function buildInvitationLink(token: string): string {
  return `${env.APP_BASE_URL}/invite/accept?token=${encodeURIComponent(token)}`;
}

export function escapeInvitationHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
