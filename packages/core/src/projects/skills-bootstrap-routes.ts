import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import {
  type BootstrapSelection,
  SkillSeedMissingError,
  UnknownPipelinePresetError,
  UnknownTemplateSetError,
  bootstrapProjectSkills,
  resolveBootstrapSelection,
} from '../skills/bootstrap-service.js';

// ISS-2A: idempotent first-run bootstrap. Thin HTTP delegate — the template
// sets, presets, and bootstrap workflow live in skills/bootstrap-service.ts.

const bootstrapParamSchema = z.object({ id: z.uuid() });

// Optional body — an absent/empty POST keeps today's defaults, so existing
// callers (web bootstrap button, MCP) are unaffected.
const bootstrapBodySchema = z.object({
  templateSet: z.string().optional(),
  preset: z.string().optional(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

// NOTE: mounted under `projectRoutes` (see ./routes.ts), which applies
// requireAuth() + assertEmailVerified() to every request — no own middleware
// here, or auth (and its email-verified DB lookup) would run twice.
export const skillsBootstrapRoutes = new Hono<{ Variables: AuthVars }>();

skillsBootstrapRoutes.post(
  '/:id/skills/bootstrap',
  zValidator('param', bootstrapParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    // ISS-453 — the body is optional (an empty POST keeps the defaults), so
    // it is parsed by hand instead of zValidator('json'), which rejects a
    // bodyless request. Unknown names fail fast before any mutation.
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    const parsedBody = bootstrapBodySchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) throw badRequest(z.flattenError(parsedBody.error));

    let selection: BootstrapSelection;
    try {
      selection = resolveBootstrapSelection(
        parsedBody.data.templateSet ?? 'forge-default',
        parsedBody.data.preset ?? 'balanced',
      );
    } catch (err) {
      // Unknown names 400 BEFORE the access check / any mutation, preserving
      // the pre-split ordering (validation ran ahead of loadProjectAccess).
      if (err instanceof UnknownTemplateSetError) throw badRequest({ templateSet: err.message });
      if (err instanceof UnknownPipelinePresetError) throw badRequest({ preset: err.message });
      throw err;
    }

    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    try {
      const result = await bootstrapProjectSkills(id, userId, selection);
      if (result.alreadyBootstrapped) return c.json(result);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof SkillSeedMissingError) {
        throw new HTTPException(503, {
          message: err.message,
          cause: { code: err.code },
        });
      }
      throw err;
    }
  },
);
