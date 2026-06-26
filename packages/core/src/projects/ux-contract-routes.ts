import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  projects,
  uxContractRules,
  uxFindings,
  uxRuleGroups,
  uxRuleSeverities,
  uxRuleSources,
  uxRuleStatuses,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { UX_PRESETS, type UxStackProfile, compilePresetToRules } from './ux-contract-presets.js';
import { recompileAndPersistUxContract } from './ux-contract-recompile.js';

const projectIdParamSchema = z.object({ id: z.uuid() });
const ruleIdParamSchema = z.object({ ruleId: z.uuid() });

const ruleCreateSchema = z
  .object({
    group: z.enum(uxRuleGroups),
    text: z.string().trim().min(1).max(4000),
    severity: z.enum(uxRuleSeverities).optional().default('must'),
    source: z.enum(uxRuleSources).optional().default('manual'),
    status: z.enum(uxRuleStatuses).optional().default('active'),
    orderIndex: z.number().int().optional().default(0),
  })
  .strict();

const rulePatchSchema = z
  .object({
    group: z.enum(uxRuleGroups).optional(),
    text: z.string().trim().min(1).max(4000).optional(),
    severity: z.enum(uxRuleSeverities).optional(),
    source: z.enum(uxRuleSources).optional(),
    status: z.enum(uxRuleStatuses).optional(),
    orderIndex: z.number().int().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

// ─── Project-scoped routes (/api/projects/:id/...) ──────────────────────────

export const uxContractProjectRoutes = new Hono<{ Variables: AuthVars }>();
uxContractProjectRoutes.use('*', requireAuth(), assertEmailVerified());

uxContractProjectRoutes.get(
  '/:id/ux-contract-rules',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const statusFilter = c.req.query('status');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const conditions = [eq(uxContractRules.projectId, projectId)];
    if (statusFilter && (uxRuleStatuses as readonly string[]).includes(statusFilter)) {
      conditions.push(eq(uxContractRules.status, statusFilter as (typeof uxRuleStatuses)[number]));
    }

    const rows = await db
      .select()
      .from(uxContractRules)
      .where(and(...conditions))
      .orderBy(asc(uxContractRules.orderIndex), asc(uxContractRules.createdAt));

    return c.json(rows);
  },
);

uxContractProjectRoutes.post(
  '/:id/ux-contract-rules',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', ruleCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    const [inserted] = await db
      .insert(uxContractRules)
      .values({ projectId, ...body })
      .returning();
    if (!inserted) throw new Error('ux-contract-rules: insert returned no row');

    await recompileAndPersistUxContract(projectId);

    return c.json(inserted, 201);
  },
);

uxContractProjectRoutes.get(
  '/:id/ux-findings',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const issueIdFilter = c.req.query('issueId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const conditions = [eq(uxFindings.projectId, projectId)];
    if (issueIdFilter) {
      conditions.push(eq(uxFindings.issueId, issueIdFilter));
    }

    const rows = await db
      .select()
      .from(uxFindings)
      .where(and(...conditions))
      .orderBy(asc(uxFindings.createdAt));

    return c.json(rows);
  },
);

const applyPresetSchema = z
  .object({
    preset: z.enum(UX_PRESETS),
    toggles: z
      .object({
        emptySearchRequired: z.boolean(),
        destructiveConfirm: z.boolean(),
        a11yLevel: z.enum(['basic', 'AA']),
        mobileResponsive: z.boolean(),
        optimisticUI: z.boolean(),
      })
      .strict()
      .optional(),
    profile: z
      .object({
        projectLabel: z.string().trim().min(1).max(200),
        bindingScope: z.string().trim().min(1).max(200),
        knownGaps: z.array(z.string().max(2000)).max(50),
        ruleOverrides: z.record(z.string(), z.string().max(4000)).optional(),
        designSystem: z.object({}).passthrough().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ISS-578 — "choose, not write": compile a preset + stack profile + toggles into
// the project's rule set, persist the profile (scaffold source), recompile prose.
uxContractProjectRoutes.post(
  '/:id/ux-contract/apply-preset',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', applyPresetSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    const compiled = compilePresetToRules(
      body.preset,
      body.profile as UxStackProfile | undefined,
      body.toggles,
    );

    // Replace the project's rule set with the compiled preset.
    await db.delete(uxContractRules).where(eq(uxContractRules.projectId, projectId));
    if (compiled.length > 0) {
      await db.insert(uxContractRules).values(
        compiled.map((r) => ({
          projectId,
          group: r.group,
          text: r.text,
          severity: r.severity,
          source: r.source,
          status: r.status,
          orderIndex: r.orderIndex,
        })),
      );
    }

    // Persist the stack profile so recompile can build the scaffold from it.
    if (body.profile) {
      const [row] = await db
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const ac = {
        ...((row?.agentConfig ?? {}) as Record<string, unknown>),
        uxContractProfile: body.profile,
      };
      await db.update(projects).set({ agentConfig: ac }).where(eq(projects.id, projectId));
    }

    await recompileAndPersistUxContract(projectId);

    return c.json({ applied: compiled.length, preset: body.preset });
  },
);

// ─── Rule-id-scoped routes (/api/ux-contract-rules/:ruleId) ─────────────────

export const uxContractRuleRoutes = new Hono<{ Variables: AuthVars }>();
uxContractRuleRoutes.use('*', requireAuth(), assertEmailVerified());

async function loadRule(ruleId: string) {
  const [row] = await db
    .select({ id: uxContractRules.id, projectId: uxContractRules.projectId })
    .from(uxContractRules)
    .where(eq(uxContractRules.id, ruleId))
    .limit(1);
  if (!row) throw notFound('ux contract rule not found');
  return row;
}

uxContractRuleRoutes.patch(
  '/:ruleId',
  zValidator('param', ruleIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', rulePatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { ruleId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const rule = await loadRule(ruleId);
    const access = await loadProjectAccess(rule.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    const updates: Record<string, unknown> = { ...patch, updatedAt: new Date() };

    const [updated] = await db
      .update(uxContractRules)
      .set(updates)
      .where(eq(uxContractRules.id, ruleId))
      .returning();
    if (!updated) throw notFound('ux contract rule not found');

    await recompileAndPersistUxContract(rule.projectId);

    return c.json(updated);
  },
);

uxContractRuleRoutes.delete(
  '/:ruleId',
  zValidator('param', ruleIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { ruleId } = c.req.valid('param');
    const userId = c.get('userId');

    const rule = await loadRule(ruleId);
    const access = await loadProjectAccess(rule.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    await db.delete(uxContractRules).where(eq(uxContractRules.id, ruleId));

    await recompileAndPersistUxContract(rule.projectId);

    return c.body(null, 204);
  },
);
