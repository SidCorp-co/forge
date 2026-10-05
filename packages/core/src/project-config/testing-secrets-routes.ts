import { SELF_JOB } from '@forge/contracts/project-config';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { AUTH_COOKIE_NAME } from '../credentials/cookie-names.js';
import { verifyUserToken } from '../credentials/jwt.js';
import { isPatLike } from '../credentials/pat-format.js';
import { RefusalError } from '../lib/refusal.js';
import { parseBearerHeader } from '../middleware/bearer.js';
import { authenticatePat, type PatPrincipal } from '../middleware/require-pat.js';
import { forbidden } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { resolveTestingSecrets } from './testing-secrets.js';

export const jobTestingSecretsRoutes = new Hono();

const SECRET_REF = /^secret:\/\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/;

const paramSchema = z.object({
  id: z.union([z.uuid(), z.literal(SELF_JOB)]),
  profileId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

const unauthenticated = (message: string, code = 'UNAUTHENTICATED') =>
  new HTTPException(401, { message, cause: { code } });

const sessionRefused = () =>
  forbidden(
    'a browser or desktop session is a person signed in, and this route hands a testing secret only to the running job whose credential asks for it. A person reads a secret’s name at GET /api/projects/:id/secrets and its value nowhere.',
  );

async function isSession(token: string): Promise<boolean> {
  try {
    await verifyUserToken(token);
    return true;
  } catch {
    return false;
  }
}

// cm:guard this door admits no session and no PAT door's grant: the job credential is a token of
// the PAT format, and what it may read here is decided by the job it names, not by a grant.
async function jobCredential(c: Context): Promise<PatPrincipal> {
  const parsed = parseBearerHeader(c);
  if (parsed.kind === 'malformed') throw unauthenticated('invalid authorization header');
  if (parsed.kind === 'absent') {
    const cookie = getCookie(c, AUTH_COOKIE_NAME);
    if (cookie && (await isSession(cookie))) throw sessionRefused();
    throw unauthenticated('authentication required: present the running job’s credential');
  }
  if (!isPatLike(parsed.token)) {
    if (await isSession(parsed.token)) throw sessionRefused();
    throw unauthenticated('invalid token', 'INVALID_TOKEN');
  }
  const principal = await authenticatePat(c, parsed.token, 'read');
  if (!principal) throw unauthenticated('invalid token', 'INVALID_TOKEN');
  return principal;
}

const refsQuery = z.strictObject({
  ref: z
    .union([z.string().regex(SECRET_REF), z.array(z.string().regex(SECRET_REF)).min(1)])
    .optional(),
});

jobTestingSecretsRoutes.get(
  '/:id/testing-profiles/:profileId/secrets',
  zValidator(
    'param',
    paramSchema,
    invalid(
      'invalid path: the job id is a uuid or `self` (the job this credential runs) and the profile id matches ^[a-z][a-z0-9-]{0,62}$',
    ),
  ),
  zValidator(
    'query',
    refsQuery,
    invalid(
      'the only query is ref, repeated as needed, each secret://<scope>/<name> with both parts matching ^[a-z][a-z0-9-]{0,62}$',
      'SECRET_REF_SHAPE',
    ),
  ),
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    const { ref } = c.req.valid('query');
    const principal = await jobCredential(c);
    const outcome = await resolveTestingSecrets({
      principal,
      jobId: id,
      profileId,
      refs: ref === undefined ? null : [ref].flat(),
    });
    if (!outcome.ok) {
      const { status, code, message, details } = outcome.refusal;
      if (status === 422) throw new RefusalError([{ code, path: '', detail: message }], code);
      throw new HTTPException(status, {
        message,
        cause: { code, ...(details ? { details } : {}) },
      });
    }
    c.header('Cache-Control', 'no-store');
    return c.json(outcome.resolved);
  },
);
