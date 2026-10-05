import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { globalEffectiveMd } from './effective.js';
import { studioSkillsOf } from './read.js';

/**
 * Skill Studio listing (ISS-388). Global skills are immutable read-only templates; the only
 * per-project customization is a same-name project skill that SHADOWS the global. This surface
 * lists BOTH (non-deduped) so the UI can show default vs project and the shadow relation.
 */

const projectParamSchema = z.object({ projectId: z.uuid() });
export const skillStudioRoutes = new Hono<{ Variables: AuthVars }>();
skillStudioRoutes.use('/:projectId/skills/effective', requireAuth(), assertEmailVerified());

skillStudioRoutes.get(
  '/:projectId/skills/effective',
  zValidator('param', projectParamSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const { globals, projectSkills } = await studioSkillsOf(projectId);

    const globalByName = new Map(globals.map((g) => [g.name, g]));
    const projectByName = new Map(projectSkills.map((p) => [p.name, p]));

    const globalRows = globals.map((g) => ({
      ...g,
      skillMd: globalEffectiveMd(g),
      editable: false as const,
      shadowsGlobal: false as const,
      shadowedGlobalSkillId: null,
      shadowedByProjectSkillId: projectByName.get(g.name)?.id ?? null,
    }));

    const projectRows = projectSkills.map((p) => {
      const shadowed = globalByName.get(p.name);
      return {
        ...p,
        editable: true as const,
        shadowsGlobal: shadowed != null,
        shadowedGlobalSkillId: shadowed?.id ?? null,
        shadowedByProjectSkillId: null,
      };
    });

    return c.json([...globalRows, ...projectRows]);
  },
);
