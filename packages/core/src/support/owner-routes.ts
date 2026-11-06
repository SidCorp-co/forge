// A support room acting in its product as the owner (ISS-1013, REQ-85): the session's REST twins of
// `forge_support` `owner_consent` and `owner_act`, and the door a project admin keeps the owner's
// credential at, per product. The credential is written here and read back nowhere: the list says
// which products hold one, never a value.

import {
  supportOwnerActRequestSchema,
  supportOwnerConsentRequestSchema,
  supportOwnerCredentialRequestSchema,
} from '@forge/contracts/support';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import {
  dropOwnerCredential,
  keepOwnerCredential,
  ownerCredentialsOf,
} from './owner-credential.js';
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
      '{ headers: { <header name>: <value> } }, at most 10 headers',
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
