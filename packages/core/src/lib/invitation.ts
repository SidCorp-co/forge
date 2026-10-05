import { randomBytes } from 'node:crypto';
import { env } from './env.js';
import { digestToken } from './token-digest.js';

/**
 * Which pending invitation a call names: the emailed `token`, or the stored digest `ref` the
 * signed-in invitee's own inbox lists. A `ref` is only a handle; every use of one also requires
 * the invitee's email to match.
 */
export type InvitationKey = { token: string } | { ref: string };

export const INVITATION_REF = /^[0-9a-f]{64}$/;

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
