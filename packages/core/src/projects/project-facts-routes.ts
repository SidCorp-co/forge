import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { deleteKnowledgeEntry, upsertKnowledgeEntries } from '../knowledge/service.js';
import { assertOrgRoleOnProject, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import type { AuthVars } from '../middleware/auth.js';
import { mergeAgentConfig, readAgentConfig } from './agent-config.js';
import {
  ALWAYS_INJECT_GUARANTEE_NOTE,
  mergeProjectFacts,
  mergeProjectFactsConfig,
  PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
  projectFactsConfigPatchSchema,
  projectFactsPatchSchema,
  RESERVED_PROJECT_FACT_KEYS,
} from './project-facts.js';

// Dedicated read/patch routes for the per-project "rules" layer:
//   - `agentConfig.projectFacts`        — kebab-key → text guide map
//   - `agentConfig.projectFactsConfig`  — per-key `{ alwaysInject }` metadata
//
// Like the pipeline-config routes, these give the settings UI a typed,
// atomic-merge surface so the Project Facts tab and other agentConfig tabs
// never clobber each other's sibling keys (the wide-open `PATCH /:id`
// agentConfig escape hatch overwrites the whole blob). Unflagged: a benign
// settings surface with no runtime-gating concern.

const idParamSchema = z.object({
  id: z.uuid(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const notFound = () =>
  new HTTPException(404, {
    message: 'project not found',
    cause: { code: 'NOT_FOUND' },
  });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const projectFactsPatchBodySchema = z
  .object({
    projectFacts: projectFactsPatchSchema,
    projectFactsConfig: projectFactsConfigPatchSchema,
  })
  .strict();

export const projectFactsRoutes = new Hono<{ Variables: AuthVars }>();

projectFactsRoutes.get(
  '/:id/project-facts',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const ac = await readAgentConfig(id);
    if (ac === null) throw notFound();

    return c.json({
      projectFacts: (ac.projectFacts as Record<string, string> | undefined) ?? {},
      projectFactsConfig:
        (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {},
      maxAlwaysInjectChars: PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
      alwaysInjectGuarantee: ALWAYS_INJECT_GUARANTEE_NOTE,
    });
  },
);

projectFactsRoutes.patch(
  '/:id/project-facts',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', projectFactsPatchBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    const dropKey = (obj: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

    const ac = await mergeAgentConfig(id, (current) => {
      let next = current;
      if (patch.projectFacts !== undefined) {
        const merged = mergeProjectFacts(next.projectFacts, patch.projectFacts);
        next = merged === null ? dropKey(next, 'projectFacts') : { ...next, projectFacts: merged };
      }
      if (patch.projectFactsConfig !== undefined) {
        const merged = mergeProjectFactsConfig(next.projectFactsConfig, patch.projectFactsConfig);
        next =
          merged === null
            ? dropKey(next, 'projectFactsConfig')
            : { ...next, projectFactsConfig: merged };
      }
      return next;
    });
    if (ac === null) throw notFound();

    if (
      env.KNOWLEDGE_INJECTION_ENABLED &&
      patch.projectFacts !== undefined &&
      patch.projectFacts !== null
    ) {
      logger.warn(
        { projectId: id },
        'PATCH /project-facts is deprecated; writing through to knowledge_entries',
      );
      const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
      const factsConfig =
        (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {};
      const factsMap = (ac.projectFacts as Record<string, string> | undefined) ?? {};
      const patchEntries = Object.entries(patch.projectFacts as Record<string, string | null>);
      const writes: Parameters<typeof upsertKnowledgeEntries>[0] = [];
      for (const [key, value] of patchEntries) {
        if (reserved.has(key)) continue;
        if (value === null) {
          await deleteKnowledgeEntry(id, key).catch(() => undefined);
          continue;
        }
        writes.push({
          projectId: id,
          slug: key,
          title: key,
          body: value,
          kind: 'guide',
          injection: factsConfig[key]?.alwaysInject === true ? 'always' : 'on_demand',
          confidence: 'verified',
          authoredBy: 'human',
          orderIndex: Object.keys(factsMap).indexOf(key),
        });
      }
      if (writes.length > 0) {
        await upsertKnowledgeEntries(writes).catch((err: Error) => {
          logger.warn(
            { err: err.message, keys: writes.map((w) => w.slug) },
            'project-facts REST: knowledge write-through failed',
          );
        });
      }
    }

    return c.json({
      projectFacts: (ac.projectFacts as Record<string, string> | undefined) ?? {},
      projectFactsConfig:
        (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {},
      maxAlwaysInjectChars: PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
      alwaysInjectGuarantee: ALWAYS_INJECT_GUARANTEE_NOTE,
    });
  },
);
