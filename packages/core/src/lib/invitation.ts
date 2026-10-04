import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

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
