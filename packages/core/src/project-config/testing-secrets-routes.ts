import { SELF_JOB } from '@forge/contracts/project-config';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { AUTH_COOKIE_NAME, requestCookieValues } from '../credentials/cookie.js';
import { verifyUserToken } from '../credentials/jwt.js';
import { isPatLike } from '../credentials/pat-format.js';
import { RefusalError } from '../lib/refusal.js';
import { parseBearerHeader } from '../middleware/bearer.js';
import { authenticatePat, type PatPrincipal } from '../middleware/require-pat.js';
import { forbidden } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission } from '../permissions/index.js';
import type { SecretChoice } from './testing-secret-values.js';
import { resolveTestingSecrets } from './testing-secrets.js';

export const jobTestingSecretsRoutes = new Hono();

// a profile's credential is a `secret://<scope>/<name>` copy, or a `var://KEY` stored variable (REQ-80 BC-7)
const SECRET_REF =
  /^(secret:\/\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}|var:\/\/[A-Za-z_][A-Za-z0-9_]{0,254})$/;

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

// this door admits no session and no PAT door's grant: the job credential, or the box credential a
// declared run calls under, is a token of the PAT format, and what it may read here is decided by the
// job or run it names, not by a grant.
export async function jobCredential(c: Context): Promise<PatPrincipal> {
  const parsed = parseBearerHeader(c);
  if (parsed.kind === 'malformed') throw unauthenticated('invalid authorization header');
  if (parsed.kind === 'absent') {
    for (const cookie of requestCookieValues(c, AUTH_COOKIE_NAME)) {
      if (await isSession(cookie)) throw sessionRefused();
    }
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

const NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

// one secret per read (ISS-868, FB-464): the actor or service of the profile the run logs in as, or
// one ref the profile names; a read naming none is refused after the run is known, listing the names
const choiceQuery = z.strictObject({
  actor: z.string().regex(NAME).optional(),
  service: z.string().regex(NAME).optional(),
  ref: z.string().regex(SECRET_REF).optional(),
});

/** The one secret the query names, null where it names none, or the refusal of more than one. */
function choiceOf(query: z.infer<typeof choiceQuery>): SecretChoice | null {
  const named = (['actor', 'service', 'ref'] as const).filter((k) => query[k] !== undefined);
  if (named.length > 1) {
    throw new RefusalError(
      [
        {
          code: 'TESTING_SECRET_ONE_PER_READ',
          path: '',
          detail: `a read names one secret, and this one names ${named.join(' and ')}; read each in its own call. Nothing was read.`,
        },
      ],
      'TESTING_SECRET_ONE_PER_READ',
    );
  }
  if (query.actor !== undefined) return { actor: query.actor };
  if (query.service !== undefined) return { service: query.service };
  if (query.ref !== undefined) return { ref: query.ref };
  return null;
}

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
    choiceQuery,
    invalid(
      'the query names one secret, once: actor=<actor name> or service=<service name> as the testing profile declares them, or ref=secret://<scope>/<name> (both parts ^[a-z][a-z0-9-]{0,62}$) or var://<KEY> the profile names',
      'SECRET_REF_SHAPE',
    ),
  ),
  // the credential is the whole gate: a running job's, or a box's naming a run it declared, and what
  // it reads is decided by that job or run, never by a project grant (`jobCredential`)
  requiresNoPermission(
    'a running job’s credential, or a box’s naming a run it declared; the job or run decides the one profile and secret it reads',
  ),
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    const asked = choiceOf(c.req.valid('query'));
    const principal = await jobCredential(c);
    const outcome = await resolveTestingSecrets({
      principal,
      jobId: id,
      profileId,
      asked,
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
