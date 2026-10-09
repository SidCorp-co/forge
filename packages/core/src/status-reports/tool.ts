import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { saveTemplateReport } from './save.js';

// The Assistant's one save act: a template run it made this turn, with the narrative it wrote, kept
// in the project's report history through the same service as POST /api/projects/:id/status/reports.
// Before it, the Assistant could only say it had saved a report, which the reply check holds
// (`messaging/creation-claims-rule.ts`; QA of ISS-422 on dev.185).

const saveInput = z.strictObject({
  projectId: z.uuid(),
  templateId: z.string().min(1).max(64).describe('the template the runs were made by'),
  runIds: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(12)
    .describe(
      "the run of each of the template's queries, in order, as forge_template returned them",
    ),
  narrative: z
    .strictObject({
      summary: z.string().optional(),
      risks: z.string().optional(),
      recommendations: z.string().optional(),
    })
    .optional()
    .describe('the slots as you stated them; each is checked against what the blocks show'),
  findings: z
    .array(z.string())
    .max(24)
    .optional()
    .describe("each block's finding, in order, as forge_template returned them"),
});

export const forgeTemplateSaveTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_template_save',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description:
    "Saves a forge_template run of this turn to the project's report history, with its narrative, when the person asks to save or keep the report: answers the kept report's { id, templateId, asOf, … }. A slot stating a figure no block of the template shows is refused by name, as forge_template refuses it. Say a report is saved only after this answers, and name what it answered.",
  inputSchema: zodToMcpSchema(saveInput),
  handler: async (args) => {
    const { projectId, templateId, runIds, narrative, findings } = saveInput.parse(args);
    const userId = ctx.principal.userId;
    return saveTemplateReport({
      projectId,
      access: await loadProjectAccess(projectId, userId),
      userId,
      agency: principalAgency(ctx.principal),
      templateId,
      runIds,
      narrative: narrative ?? {},
      findings,
    });
  },
});
