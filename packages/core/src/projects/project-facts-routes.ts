import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { deleteKnowledgeEntry, upsertKnowledgeEntry } from '../knowledge/service.js';
import { assertOrgRoleOnProject, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import type { AuthVars } from '../middleware/auth.js';
import { mergeAgentConfig, readAgentConfig } from './agent-config.js';
import {
  PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
  RESERVED_PROJECT_FACT_KEYS,
  mergeProjectFacts,
  mergeProjectFactsConfig,
  projectFactsConfigPatchSchema,
  projectFactsPatchSchema,
} from './project-facts.js';

// ─── Project facts (ISS-521) ─────────────────────────────────────────────────
//
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

// NOTE: mounted under `projectRoutes` (see ./routes.ts), which applies
// requireAuth() + assertEmailVerified() to every request — no own middleware
// here, or auth (and its email-verified DB lookup) would run twice.
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

    // A `null` merge result drops the key entirely (via filter rather than
    // `delete` to match the stateContext branch + satisfy lint/noDelete).
    const dropKey = (obj: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

    // Atomic read-modify-write of agentConfig — only the projectFacts /
    // projectFactsConfig sub-keys are touched; sibling keys (pipelineConfig,
    // stateContext, …) survive. Reserved (derived) keys are dropped by the
    // mergers, so a caller can't shadow base-branch/test-creds/etc.
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

    // AC6: write-through to knowledge_entries when the flag is ON.
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
      for (let i = 0; i < patchEntries.length; i++) {
        const [key, value] = patchEntries[i] as [string, string | null];
        if (reserved.has(key)) continue;
        if (value === null) {
          await deleteKnowledgeEntry(id, key).catch(() => undefined);
        } else {
          const alwaysInject = factsConfig[key]?.alwaysInject === true;
          await upsertKnowledgeEntry({
            projectId: id,
            slug: key,
            title: key,
            body: value,
            kind: 'guide',
            injection: alwaysInject ? 'always' : 'on_demand',
            confidence: 'verified',
            authoredBy: 'human',
            orderIndex: Object.keys(factsMap).indexOf(key),
          }).catch((err: Error) => {
            logger.warn(
              { err: err.message, key },
              'project-facts REST: knowledge write-through failed',
            );
          });
        }
      }
    }

    return c.json({
      projectFacts: (ac.projectFacts as Record<string, string> | undefined) ?? {},
      projectFactsConfig:
        (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {},
      maxAlwaysInjectChars: PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
    });
  },
);
