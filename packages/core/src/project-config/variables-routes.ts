// The REST doors of a project's environment variables (REQ-80, design `environment-variables` r3):
// the list, add, change, delete and reveal (BC-1, BC-2), the audit (BC-2), agent proposals and their
// decision (BC-6), and the run door a declared run or job reads its environment's variables at (BC-8).

import { SELF_JOB } from '@forge/contracts/project-config';
import {
  createVariableRequestSchema,
  decideVariableProposalRequestSchema,
  proposeVariableRequestSchema,
  updateVariableRequestSchema,
  VARIABLE_KEY,
} from '@forge/contracts/variables';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { jobCredential } from './testing-secrets-routes.js';
import {
  decideVariableProposal,
  proposeVariable,
  readVariableProposals,
} from './variables-proposals.js';
import { deliverRunVariables } from './variables-run-door.js';
import {
  changeVariable,
  createVariable,
  readVariableEvents,
  readVariables,
  removeVariable,
  revealVariable,
} from './variables-service.js';

export const variableRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/variables', '/:id/variables/*']) {
  variableRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const variableParam = zValidator(
  'param',
  z.object({ id: z.uuid(), variable: z.uuid() }),
  invalid('invalid path: the project and variable ids are uuids'),
);
const proposalParam = zValidator(
  'param',
  z.object({ id: z.uuid(), proposal: z.uuid() }),
  invalid('invalid path: the project and proposal ids are uuids'),
);

variableRoutes.get('/:id/variables', projectParam, noQuery, async (c) =>
  c.json(await readVariables(c.req.valid('param').id, c.get('userId'))),
);

variableRoutes.post(
  '/:id/variables',
  projectParam,
  strictBody(
    createVariableRequestSchema,
    '{ key, value, environment: <declared environment> | null, type: plain | secret | file, protected } adds a variable (REQ-80 BC-2)',
  ),
  async (c) =>
    c.json(
      await createVariable(c.req.valid('param').id, c.get('userId'), c.req.valid('json')),
      201,
    ),
);

variableRoutes.get('/:id/variables/events', projectParam, noQuery, async (c) =>
  c.json(await readVariableEvents(c.req.valid('param').id, c.get('userId'))),
);

variableRoutes.get('/:id/variables/proposals', projectParam, noQuery, async (c) =>
  c.json(await readVariableProposals(c.req.valid('param').id, c.get('userId'))),
);

variableRoutes.post(
  '/:id/variables/proposals',
  projectParam,
  strictBody(
    proposeVariableRequestSchema,
    '{ issue, act: set | delete, key, environment, type?, protected?, value?, reason } proposes a change an issue needs (REQ-80 BC-6)',
  ),
  async (c) =>
    c.json(
      await proposeVariable(c.req.valid('param').id, c.get('userId'), c.req.valid('json')),
      201,
    ),
);

variableRoutes.post(
  '/:id/variables/proposals/:proposal/decision',
  proposalParam,
  strictBody(
    decideVariableProposalRequestSchema,
    '{ decision: approve | reject, reason } decides a proposed variable change (REQ-80 BC-6)',
  ),
  async (c) => {
    const { id, proposal } = c.req.valid('param');
    return c.json(await decideVariableProposal(id, c.get('userId'), proposal, c.req.valid('json')));
  },
);

variableRoutes.put(
  '/:id/variables/:variable',
  variableParam,
  strictBody(
    updateVariableRequestSchema,
    '{ baseVersion, value?, type?, protected? } changes a variable against the version read; its key and scope stay (REQ-80 BC-2)',
  ),
  async (c) => {
    const { id, variable } = c.req.valid('param');
    return c.json(await changeVariable(id, c.get('userId'), variable, c.req.valid('json')));
  },
);

variableRoutes.delete(
  '/:id/variables/:variable',
  variableParam,
  zValidator(
    'query',
    z.strictObject({ baseVersion: z.coerce.number().int().min(1) }),
    invalid('the only query is baseVersion, the version of the variable read before deleting it'),
  ),
  async (c) => {
    const { id, variable } = c.req.valid('param');
    return c.json(
      await removeVariable(id, c.get('userId'), variable, c.req.valid('query').baseVersion),
    );
  },
);

variableRoutes.post('/:id/variables/:variable/reveal', variableParam, noQuery, async (c) => {
  const { id, variable } = c.req.valid('param');
  c.header('Cache-Control', 'no-store');
  return c.json(await revealVariable(id, c.get('userId'), variable));
});

/** `GET /api/jobs/:id/variables/:environment`: the run door (BC-8), under the run's own credential. */
export const jobVariableRoutes = new Hono();

const KEY = new RegExp(VARIABLE_KEY.source);

jobVariableRoutes.get(
  '/:id/variables/:environment',
  zValidator(
    'param',
    z.object({
      id: z.union([z.uuid(), z.literal(SELF_JOB)]),
      environment: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    }),
    invalid(
      'invalid path: the run id is a uuid or `self` (the job this credential runs), and the environment one the project declares',
    ),
  ),
  zValidator(
    'query',
    z.strictObject({
      key: z.union([z.string().regex(KEY), z.array(z.string().regex(KEY)).min(1)]).optional(),
    }),
    invalid('the only query is key, repeated as needed, each an environment variable name'),
  ),
  async (c) => {
    const { id, environment } = c.req.valid('param');
    const { key } = c.req.valid('query');
    const principal = await jobCredential(c);
    const outcome = await deliverRunVariables({
      principal,
      asked: id,
      environment,
      keys: key === undefined ? null : [key].flat(),
    });
    if (!outcome.ok) {
      // the run door's own refusals, answered as the testing-profile door answers them
      const { status, code, message, details } = outcome.refusal;
      if (status === 422) throw new RefusalError([{ code, path: '', detail: message }], code);
      throw new HTTPException(status, {
        message,
        cause: { code, ...(details ? { details } : {}) },
      });
    }
    c.header('Cache-Control', 'no-store');
    return c.json(outcome.delivered);
  },
);
