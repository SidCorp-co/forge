// The one-time write URL of a secret ask (ISS-1348 c2): `PUT /api/secret-writes/<token>` with the
// value as the body sets the one slot the ask names, once, within `SECRET_WRITE_TTL_MINUTES` of the
// act that minted it. The token in the path is the credential, as an upload ticket's is
// (`uploads/routes.ts`): unguessable, kept only as its SHA-256, short-lived, single use, and it fixes
// the slot, so the URL cannot be pointed anywhere else. It writes and reads nothing: any other method
// is refused by name, and the answer names the slot and the value's fingerprint, never the value.
// Each use is kept on the ask (when, from where) and in the slot's own audit by fingerprint; a write
// the slot's own door refuses gives the claim back, so the person can fix the file and PUT again.

import { parseSecretRef } from '@forge/contracts/project-config';
import { FILTERED } from '@forge/observability';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { fingerprintSecret, writeConnectionCredential } from '../integrations/index.js';
import { RefusalError, refused } from '../lib/refusal.js';
import { invalid, noQuery, rawBody, zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission } from '../permissions/index.js';
import { SECRET_VALUE_MAX, writeSecret, writeVariableByGrant } from '../project-config/index.js';
import {
  type AskRow,
  askOfToken,
  claimWrite,
  emitSlotFilled,
  releaseWrite,
} from './secret-asks.js';
import { slotLabelOf } from './secret-receipts.js';

const TOKEN = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const tokenParam = zValidator(
  'param',
  TOKEN,
  invalid(
    'invalid path: the write URL is /api/secret-writes/<token>, as the secret link answered it',
  ),
);

const refuse = (c: Context, code: string, detail: string) =>
  refused(c, [{ code, path: '/token', detail }], 'SUPPORT_REFUSED');

const tooLong = (c: Context) =>
  refuse(
    c,
    'SUPPORT_SECRET_WRITE_TOO_LONG',
    `a secret holds at most ${SECRET_VALUE_MAX} characters; nothing was written, and this URL still holds.`,
  );

/** Where a write came from, as the request says it: its address and its client, never its body. */
function fromOf(c: Context): string {
  const address = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'direct';
  const client = c.req.header('user-agent')?.split(' ')[0] ?? 'unknown client';
  return `${address} ${client}`.slice(0, 200);
}

/** Why a token no write may use is refused: unknown, spent, or past its time. */
async function unusable(c: Context, token: string) {
  const ask = await askOfToken(token);
  if (!ask?.writeExpiresAt) {
    return refuse(
      c,
      'SUPPORT_SECRET_WRITE_UNKNOWN',
      'this write URL names no secret ask; ask the agent for a new one. Nothing was written.',
    );
  }
  if (ask.writeUsedAt) {
    return refuse(
      c,
      'SUPPORT_SECRET_WRITE_USED',
      `this write URL was used at ${ask.writeUsedAt.toISOString()} and is spent: it sets its slot once. Ask the agent for a new one to set it again. Nothing was written.`,
    );
  }
  return refuse(
    c,
    'SUPPORT_SECRET_WRITE_EXPIRED',
    `this write URL expired at ${ask.writeExpiresAt.toISOString()}; ask the agent for a new one. Nothing was written.`,
  );
}

/** The value set at the ask's slot through the slot's own door; its fingerprint. */
async function writeSlot(ask: AskRow, value: string, from: string): Promise<string> {
  const detail = { via: 'presigned', ask: ask.id, from };
  const s = ask.slot;
  if (ask.kind === 'variable') {
    const written = await writeVariableByGrant({
      projectId: ask.projectId,
      key: s.key ?? '',
      environment: s.environment ?? null,
      value,
      detail,
    });
    return written.fingerprint;
  }
  if (ask.kind === 'testing') {
    const ref = parseSecretRef(s.ref ?? '');
    // the ask copied its profile's credential, which the profile's schema holds to this shape
    if (!ref) {
      throw new Error(
        `secret ask ${ask.id} names ${JSON.stringify(s.ref)}, which is no secret://<scope>/<name>; nothing was written`,
      );
    }
    const written = await writeSecret({
      projectId: ask.projectId,
      scope: ref.scope,
      name: ref.name,
      value,
      actor: { id: null, tokenId: null, agency: 'human' },
      detail,
    });
    if (!written.ok) {
      throw new RefusalError(
        'refusals' in written
          ? written.refusals
          : [
              {
                code: written.code,
                path: '',
                detail:
                  'INTEGRATION_MASTER_KEY is not set on this core, so a secret cannot be encrypted; nothing was written.',
              },
            ],
        'CONFIG_REFUSED',
      );
    }
    return fingerprintSecret(ask.projectId, value);
  }
  const filled = await writeConnectionCredential(s.connection ?? '', value);
  // the adapter builds the fact and emits none: the asking threads hear of it from here
  await emitSlotFilled(filled);
  return filled.fingerprint;
}

export const secretWriteRoutes = new Hono();

secretWriteRoutes.put(
  '/:token',
  requiresNoPermission(
    'the write token in the path is the credential: unguessable, single use and short-lived, minted by a room agent’s secret link for one slot, which it fixes; it writes that slot and reads nothing',
  ),
  tokenParam,
  rawBody(
    'application/octet-stream',
    "The secret's value itself, as a file's bytes (curl --data-binary @file); one closing newline is the file's and is dropped. Its slot comes from the write token.",
  ),
  // bytes, the most a value of SECRET_VALUE_MAX characters takes; its characters are counted below
  bodyLimit({ maxSize: SECRET_VALUE_MAX * 4 + 2, onError: (c) => tooLong(c) }),
  async (c) => {
    const { token } = c.req.valid('param');
    const from = fromOf(c);
    // a file's one closing newline is the file's, not the value's
    const value = (await c.req.text()).replace(/\r?\n$/, '');
    // counted as the page's door counts it (`secret-routes.ts:secretBody`), before the URL is claimed
    if (value.length > SECRET_VALUE_MAX) return tooLong(c);
    const ask = await claimWrite(token, from);
    if (!ask) return unusable(c, token);
    if (value === '' || value === FILTERED) {
      await releaseWrite(ask.id);
      return refuse(
        c,
        'SUPPORT_SECRET_WRITE_EMPTY',
        'the body holds no value: PUT the value itself, e.g. curl -X PUT --data-binary @<file> <this URL>. Nothing was written, and this URL still holds.',
      );
    }
    try {
      const fingerprint = await writeSlot(ask, value, from);
      return c.json({
        slot: slotLabelOf(ask),
        kind: ask.kind,
        fingerprint,
        at: new Date().toISOString(),
        says: 'set once; this URL is spent. The thread that asked is told by this fingerprint, never the value.',
      });
    } catch (err) {
      // the slot's own door refused it, or it failed: nothing was set, so the URL still holds
      await releaseWrite(ask.id);
      throw err;
    }
  },
);

// a write URL reads nothing: a GET (and so a HEAD) is refused by name, whatever the token
secretWriteRoutes.get(
  '/:token',
  requiresNoPermission(
    'refused for every caller: a write URL takes a PUT alone and answers no read',
  ),
  noQuery,
  (c) =>
    refuse(
      c,
      'SUPPORT_SECRET_WRITE_ONLY',
      'a secret write URL takes a PUT of the value and reads nothing; this GET answered nothing.',
    ),
);
