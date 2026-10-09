import type { CodeTraceResponse, CodeTraceScope, CodeTraceUnit } from '@forge/contracts/modules';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { THIS_REPOSITORY } from './lib/this-repository.js';
import { type AuthVars, requireAuth } from './middleware/auth.js';
import declaration from './modules.json' with { type: 'json' };
import { actorFor, projectResource, requireCan } from './permissions/index.js';
import { readDeclaredSource } from './project-config/index.js';

const SECTIONS: Record<CodeTraceScope, 'modules' | 'web' | 'runner'> = {
  core: 'modules',
  web: 'web',
  runner: 'runner',
};

/** The requirement trace this build declares (ISS-221): Forge's own modules and what they serve. */
export function codeTrace(): CodeTraceResponse {
  const units: CodeTraceUnit[] = [];
  for (const [scope, section] of Object.entries(SECTIONS) as [CodeTraceScope, string][]) {
    const declared = (
      declaration as unknown as Record<string, Record<string, { serves?: string[] }>>
    )[section];
    for (const [unit, spec] of Object.entries(declared ?? {}))
      units.push({ scope, unit, serves: spec.serves ?? [] });
  }
  return {
    units,
    total: units.length,
    untraced: units.filter((u) => u.serves.length === 0).length,
  };
}

const NONE: CodeTraceResponse = { units: [], total: 0, untraced: 0 };

/** A project reads this trace only when its declared repository is the one the trace describes. */
export const codeTraceRoutes = new Hono<{ Variables: AuthVars }>();
codeTraceRoutes.get('/projects/:id/code-trace', requireAuth(), async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HTTPException(400, {
      message: 'invalid path: the project id is a uuid',
      cause: { code: 'BAD_REQUEST' },
    });
  }
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const { repository } = await readDeclaredSource(id);
  return c.json(repository === THIS_REPOSITORY ? codeTrace() : NONE);
});
