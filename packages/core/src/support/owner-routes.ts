// A support room acting in its product as the owner (ISS-1013, REQ-85): the session's REST twins of
// `forge_support` `owner_consent`, `owner_act` and `owner_sign_in`, the door a project admin keeps
// the owner's credential at, per product, and the page the product returns the owner's browser to
// once he confirms the sign-in core started (ISS-1047). The credential is written here and read back
// nowhere: the list says which products hold one, never a value.

import {
  supportOwnerActRequestSchema,
  supportOwnerConsentRequestSchema,
  supportOwnerCredentialRequestSchema,
  supportOwnerSignInRequestSchema,
} from '@forge/contracts/support';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam, requiresPublic } from '../permissions/index.js';
import {
  dropOwnerCredential,
  keepOwnerCredential,
  ownerCredentialsOf,
} from './owner-credential.js';
import { finishOwnerSignIn, type OwnerSignInFinished } from './owner-sign-in.js';
import { act, SESSION_ONLY } from './session-door.js';

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const bindingParam = zValidator(
  'param',
  z.object({ id: z.uuid(), bindingId: z.uuid() }),
  invalid('invalid path: a project uuid and its support-api binding uuid'),
);

const ADMIN = requiresOnParam('project.admin', 'id');
const READ = requiresOnParam('project.read', 'id');

export function mountOwnerRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/owner-consents',
    projectParam,
    SESSION_ONLY,
    strictBody(
      supportOwnerConsentRequestSchema,
      '{ thread, message, decision: give | withdraw, product? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'owner_consent', ...c.req.valid('json') }),
  );

  app.post(
    '/:id/support/session/owner-acts',
    projectParam,
    SESSION_ONLY,
    strictBody(supportOwnerActRequestSchema, '{ thread, tool, args? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'owner_act', ...c.req.valid('json') }),
  );

  app.post(
    '/:id/support/session/owner-sign-ins',
    projectParam,
    SESSION_ONLY,
    strictBody(supportOwnerSignInRequestSchema, '{ thread, product? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'owner_sign_in', ...c.req.valid('json') }),
  );

  // which products core keeps the owner's credential for: names, never values
  app.get('/:id/support/owner-credentials', projectParam, READ, noQuery, async (c) =>
    c.json({ credentials: await ownerCredentialsOf(c.req.valid('param').id) }),
  );

  app.put(
    '/:id/support/owner-credentials/:bindingId',
    bindingParam,
    ADMIN,
    strictBody(
      supportOwnerCredentialRequestSchema,
      '{ headers: { <header name>: <value> } }, at most 10 headers; or { oauth: { accessToken, refreshToken?, expiresIn? } }',
    ),
    async (c) => {
      const { id, bindingId } = c.req.valid('param');
      const body = c.req.valid('json');
      const actor = restActor(c);
      const out = await keepOwnerCredential({
        projectId: id,
        bindingId,
        body,
        actor: { id: actor.id, tokenId: actor.tokenId, agency: actor.agency },
      });
      if (out.ok) return c.json(out.value);
      if ('code' in out) {
        throw new HTTPException(503, {
          message:
            'INTEGRATION_MASTER_KEY is not set on this core, so the credential cannot be sealed; nothing was kept.',
          cause: { code: out.code },
        });
      }
      return refused(c, out.refusals, 'SUPPORT_REFUSED');
    },
  );

  app.delete(
    '/:id/support/owner-credentials/:bindingId',
    bindingParam,
    ADMIN,
    noQuery,
    async (c) => {
      const { id, bindingId } = c.req.valid('param');
      const actor = restActor(c);
      const out = await dropOwnerCredential({
        projectId: id,
        bindingId,
        actor: { id: actor.id, tokenId: actor.tokenId, agency: actor.agency },
      });
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json(out.value);
    },
  );
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The one page the owner's browser lands on: signed in, or why not. */
function signInPage(out: OwnerSignInFinished): string {
  const title = out.ok ? `Signed in to ${out.product}` : 'Not signed in';
  const line = out.ok
    ? 'Forge keeps your sign-in for your assistant. You can close this page.'
    : out.why;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fff;color:#1a1a1a}main{max-width:32rem;margin:0 auto}@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(line)}</p></main></body></html>`;
}

const callbackQuery = zValidator(
  'query',
  // the product adds keys of its own (iss, session_state); only these are read
  z.looseObject({
    code: z.string().max(4000).optional(),
    state: z.string().max(500).optional(),
    error: z.string().max(200).optional(),
  }),
  invalid('invalid query: code, state, or error as the product returned them'),
);

/**
 * `GET /api/support/owner-sign-in/callback`: the product returns the owner's browser here with its
 * code and the state core issued (ISS-1047). It carries no Forge session: the state, spent once,
 * and the PKCE verifier only core holds are the key.
 */
export const ownerSignInCallbackRoutes = new Hono();
ownerSignInCallbackRoutes.get(
  '/owner-sign-in/callback',
  requiresPublic(
    'the product sends the owner’s browser back with its code and the state core issued; that state, spent once, and the PKCE verifier only core holds are the key',
  ),
  callbackQuery,
  async (c) => {
    const { code, state, error } = c.req.valid('query');
    const out = await finishOwnerSignIn({ code, state, error });
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(signInPage(out), out.ok ? 200 : out.status);
  },
);
