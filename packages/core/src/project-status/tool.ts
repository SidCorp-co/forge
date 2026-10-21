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
import { pruneStatus } from './prune.js';
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
  description: `How this project stands now, as the dashboard and status report read it. Call it FIRST for status, progress, what shipped, what is stuck or late, who owes what, the next release or the roadmap. Say stuck first (items core reads stuck: reason, the steward's line 1 as note, href), then needsYou (your top 3 decisions with the recommended answer; more counts the rest). A section holding nothing is left out and named in \`omitted\`: never report it as zeros. Each section has its asOf: shipped (counts cover the last \`days\`, default ${PROJECT_STATUS_DAYS_DEFAULT}; \`releases\` lists only the newest ${PROJECT_STATUS_ROWS}), inFlight (open issues by status; those a run is on), waits (what members owe as people, by person), requirements (BCs proven; issue progress; delivery forecast), nextRelease (state, progress, whose turn, a draft behind it), late (past their usual time), roadmap (now/next/later). A forecast is a p50-p85 range, never a promise.`,
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, days } = input.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return pruneStatus(
      await readProjectStatus(
        projectId,
        statusViewerOf(access, userId, principalAgency(ctx.principal)),
        days ?? PROJECT_STATUS_DAYS_DEFAULT,
      ),
    );
  },
});
