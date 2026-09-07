/**
 * ISS-950 (Tier 3c of ISS-587) — the four generated diagrams as a read.
 *
 * `GET /api/projects/:id/module-diagrams/:kind` computes the diagram from the rows as they are at
 * the moment of the request. It is deliberately uncached: the issue requires that a diagram cannot
 * be quietly older than the knowledge it renders, and nothing between the rows and the response
 * can go stale if there is nothing between them.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { loadModuleDiagramSnapshot } from './module-diagram-source.js';
import {
  generateModuleDiagram,
  ModuleDiagramError,
  moduleDiagramKinds,
} from './module-diagrams.js';

const paramSchema = z.object({ id: z.uuid(), kind: z.enum(moduleDiagramKinds) });

export const moduleDiagramRoutes = new Hono<{ Variables: AuthVars }>();
moduleDiagramRoutes.use('*', requireAuth(), assertEmailVerified());

// cm:guard a refusal is a 409 carrying `cause.code`, never a 200 with an empty diagram — the issue's rule is that a generator which cannot render what it was asked for says so by name, and an empty mindmap is indistinguishable from a project nobody has classified.
moduleDiagramRoutes.get(
  '/:id/module-diagrams/:kind',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const { id: projectId, kind } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'viewer', 'not a project member');

    const snapshot = await loadModuleDiagramSnapshot(projectId);
    try {
      return c.json({
        kind,
        mermaid: generateModuleDiagram(kind, snapshot),
        moduleCount: snapshot.modules.length,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ModuleDiagramError) {
        throw new HTTPException(409, { message: err.message, cause: { code: err.code } });
      }
      throw err;
    }
  },
);
