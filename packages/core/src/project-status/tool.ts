import {
  PROJECT_STATUS_DAYS_DEFAULT,
  PROJECT_STATUS_DAYS_MAX,
} from '@forge/contracts/project-status';
import { z } from 'zod';
import { needsYouViewerOf } from '../development/index.js';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { requireHeld } from '../permissions/index.js';
import { readProjectStatus } from './read.js';

const input = z.strictObject({
  projectId: z.uuid(),
  days: z.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
});

export const forgeProjectStatusTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_project_status',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `How this project stands now, the same read the dashboard and the status report draw. Call it FIRST for any question about status, progress, what shipped or was released, what is in progress, what is late or blocked, what waits on whom, the next release or the roadmap. Returns, each section with its own asOf: shipped (releases shipped in the last \`days\`, default ${PROJECT_STATUS_DAYS_DEFAULT}, newest first, with their issues, requirements and what was verified; requirementsShipped), inFlight (open issues by status, the ones a run is on), waits (every row whose turn is a person's: who and the act), requirements (proven criteria of total, by requirement, with shipped/live issues and the delivery forecast), nextRelease (the draft: version, issues, forecast, who cuts it), late (items core calls late, with reason), roadmap (now / next / later from requirement state). A forecast is a p50-p85 range labelled forecast, never a promise.`,
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, days } = input.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return readProjectStatus(
      projectId,
      needsYouViewerOf(access, userId, principalAgency(ctx.principal)),
      days ?? PROJECT_STATUS_DAYS_DEFAULT,
    );
  },
});
