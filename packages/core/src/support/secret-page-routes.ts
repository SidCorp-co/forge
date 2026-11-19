// The doors of a project's Secrets page (ISS-1348). `GET …/support/secrets` reads the page whole:
// requests first, then every secret grouped by what uses it, each saying whether it holds a value and
// never what (REQ-80 BC-6). `POST …/support/secrets/requests/:ask/write-url` gives the person filling a
// request its one-time write URL, for a value that sits in a file: minted for that one slot, by a
// person who may write it there (env.manage for a variable, project.admin for a testing or connection
// credential), as a new ask of the same thread, so the thread that asked hears when it is filled. A
// value itself is written through the slot's own door, which judges it.

import type { SecretWriteMinted } from '@forge/contracts/secret-slots';
import { ENV_MANAGE } from '@forge/contracts/variables';
import type { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { actorFor, requireDeclaredOn, requiresOnParam } from '../permissions/index.js';
import { refusalOf } from './refusals.js';
import { againOf, askOf, recordAsk } from './secret-asks.js';
import { secretWriteOf } from './secret-link.js';
import { readSecretSlots } from './secret-page.js';

const READ = requiresOnParam('project.read', 'id');

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const askParam = zValidator(
  'param',
  z.object({ id: z.uuid(), ask: z.uuid() }),
  invalid('invalid path: a project uuid and a request uuid, as the Secrets page lists it'),
);

const WRITES = { variable: ENV_MANAGE, testing: 'project.admin', integration: 'project.admin' } as const;

export function mountSecretPageRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.get('/:id/support/secrets', projectParam, READ, noQuery, async (c) =>
    c.json(await readSecretSlots(c.req.valid('param').id)),
  );

  app.post('/:id/support/secrets/requests/:ask/write-url', askParam, READ, noQuery, async (c) => {
    const { id, ask: askId } = c.req.valid('param');
    const no = (code: Parameters<typeof refusalOf>[0], detail: string) =>
      refused(c, [refusalOf(code, '/ask', detail)], 'SUPPORT_REFUSED');
    const userId = c.get('userId');
    if (actorFor(userId).agency === 'agent') {
      return no(
        'SUPPORT_SECRET_ASK_PERSON_ONLY',
        'a write URL from the Secrets page is a person’s: an agent asks for one with support.secret_link { presign: true }. Nothing was minted.',
      );
    }
    const ask = await askOf(id, askId);
    if (!ask) {
      return no(
        'SUPPORT_SECRET_ASK_UNKNOWN',
        'this project has no request by that id in the last week; its Secrets page lists the ones it has. Nothing was minted.',
      );
    }
    if (ask.filledAt) {
      return no(
        'SUPPORT_SECRET_ASK_FILLED',
        `this request was filled at ${ask.filledAt.toISOString()}; replace its value on the Secrets page. Nothing was minted.`,
      );
    }
    await requireDeclaredOn(id, userId, WRITES[ask.kind], 'minting a write URL for this request');
    const web = webBaseUrl();
    if (!web) {
      return no(
        'SUPPORT_SECRET_LINK_NO_WEB',
        'this Forge knows no address of its web app (CORS_ORIGINS is unset), so it has no write URL to give. Nothing was minted.',
      );
    }
    const { row, token } = await recordAsk(againOf(ask), true);
    if (!token || !row.writeExpiresAt) throw new Error('support: a presigned ask kept no token');
    const minted: SecretWriteMinted = secretWriteOf(web, token, row.writeExpiresAt);
    return c.json(minted, 201);
  });
}
