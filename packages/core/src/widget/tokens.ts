// A widget session token and a status link token: 256 random bits, base64url, behind the
// contract's prefixes, which the log scrubber recognises. A session token is stored only as its
// SHA-256 and shown once. A status token is looked up only by its SHA-256 too; the visitor's own
// draft also keeps it sealed in the integration vault, so their frame can show the link after a
// reload (`schema-widget.ts:widgetDrafts`).

import { randomBytes } from 'node:crypto';
import {
  WIDGET_SESSION_TOKEN_PATTERN,
  WIDGET_SESSION_TOKEN_PREFIX,
  WIDGET_STATUS_TOKEN_PATTERN,
  WIDGET_STATUS_TOKEN_PREFIX,
  widgetStatusPath,
} from '@forge/contracts/widget';
import { decryptSecret, encryptSecret } from '../integrations/index.js';
import { digestToken } from '../lib/token-digest.js';
import { webBaseUrl } from '../lib/web-base-url.js';

const mint = (prefix: string) => {
  const token = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { token, hash: digestToken(token) };
};

export const mintSessionToken = () => mint(WIDGET_SESSION_TOKEN_PREFIX);
export const mintStatusToken = () => mint(WIDGET_STATUS_TOKEN_PREFIX);

/** The SHA-256 a session token is looked up by, or null for text that is not one. */
export function sessionTokenHash(token: string): string | null {
  return WIDGET_SESSION_TOKEN_PATTERN.test(token) ? digestToken(token) : null;
}

/** The status link a visitor keeps: the web's status page for the token. */
export const statusUrlOf = (token: string) => `${webBaseUrl() ?? ''}${widgetStatusPath(token)}`;

export const sealStatusToken = (token: string): Buffer => encryptSecret(token);
export const openStatusToken = (sealed: Buffer): string => decryptSecret(sealed);

/** The SHA-256 a status token is looked up by, or null for text that is not one. */
export function statusTokenHash(token: string): string | null {
  return WIDGET_STATUS_TOKEN_PATTERN.test(token) ? digestToken(token) : null;
}
