import {
  PROJECT_STATUS_DAYS_DEFAULT,
  PROJECT_STATUS_DAYS_MAX,
  PROJECT_STATUS_ROWS,
} from '@forge/contracts/project-status';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { requireHeld } from '../permissions/index.js';
import { readProjectStatus, statusViewerOf } from './read.js';

const input = z.strictObject({
  projectId: z.uuid(),
  days: z.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
});

export const forgeProjectStatusTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_project_status',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `How this project stands now: the read the dashboard and status report draw. Call it FIRST for status, progress, what shipped, what is in progress, late or blocked, who owes what, the next release or the roadmap. Sections, each with its asOf: shipped (releaseCount and issueCount count the whole last \`days\`, default ${PROJECT_STATUS_DAYS_DEFAULT}; \`releases\` lists only the newest ${PROJECT_STATUS_ROWS}, so count from releaseCount; each with issues, requirements, what was verified), inFlight (open issues by status; those a run is on), waits (rows whose turn is a person's: who, act), requirements (BCs proven of total; issues as progress shipped/awaitingRelease/toDo; delivery forecast), nextRelease (nearest users: a release already cut before the draft; state, progress, whose turn, a draft behind it), late (items core calls late, why), roadmap (now/next/later by requirement state). A forecast is a p50-p85 range, never a promise.`,
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, days } = input.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return readProjectStatus(
      projectId,
      statusViewerOf(access, userId, principalAgency(ctx.principal)),
      days ?? PROJECT_STATUS_DAYS_DEFAULT,
    );
  },
});
