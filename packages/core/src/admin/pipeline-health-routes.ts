/**
 * Admin pipeline-health surface.
 *
 * GET /api/admin/pipeline/health
 *   Lists issues currently parked at `needs_info` (stopped on a person, whatever the park's
 *   kind — the old `waiting` park folded in, ISS-54) plus an aggregate failure-kind breakdown
 *   for SRE dashboards.
 */

import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { readPipelineHealth } from './read.js';

export const pipelineHealthAdminRoutes = new Hono<{ Variables: AuthVars }>();
pipelineHealthAdminRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

pipelineHealthAdminRoutes.get('/health', async (c) => c.json(await readPipelineHealth()));
