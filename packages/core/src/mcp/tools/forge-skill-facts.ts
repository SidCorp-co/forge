import { z } from 'zod';
import { jobTypes } from '../../db/schema.js';
import { getResolvedFact, listResolvedFacts } from '../../prompt/facts/resolve.js';
import { assertPrincipalIsMember, zodToMcpSchema } from './lib.js';
import type { ContextScopedMcpToolFactory } from './lib.js';

const listInputSchema = z
  .object({ projectId: z.uuid(), stage: z.enum(jobTypes).optional() })
  .strict();
const getInputSchema = z
  .object({ projectId: z.uuid(), id: z.string().min(1), stage: z.enum(jobTypes).optional() })
  .strict();

export const forgeSkillFactsListTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skill_facts.list',
  description:
    'List Forge Facts — the FIXED Forge process knowledge a skill author references instead of copy-pasting (status ladder, complexity/priority/category enums, relation kinds, decompose protocol, plan/release-notes/handoff formats, worktree protocol). Each fact carries id, tier (`mandatory` = always injected; `contextual` = insert via `{{forge:<id>}}`), namespace, and a project-resolved `preview`. Pass optional `stage` to tailor stage-specific facts (e.g. `handoff`). Call this while AUTHORING a skill to learn the real values rather than guessing. Requires project membership.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, stage } = listInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, projectId);
    const facts = await listResolvedFacts(projectId, stage ?? null);
    return { facts };
  },
});

export const forgeSkillFactsGetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skill_facts.get',
  description:
    'Fetch one Forge Fact by id (project-resolved), returning its full canonical `preview` text — the exact block a skill body gets when it references `{{forge:<id>}}`. Pass optional `stage` for stage-specific facts. Throws NOT_FOUND for an unknown id. Requires project membership.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { projectId, id, stage } = getInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, projectId);
    const fact = await getResolvedFact(projectId, id, stage ?? null);
    if (!fact) throw new Error('NOT_FOUND: unknown fact id');
    return { fact };
  },
});
