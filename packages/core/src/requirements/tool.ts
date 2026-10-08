import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import { type ContextScopedMcpToolFactory, refusedAnswer, zodToMcpSchema } from '../lib/tool.js';
import { listRequirementsAs, readRequirementAs } from './read.js';
import { revisionFields } from './route-kit.js';
import { createRequirement, writeRevision } from './service.js';
import type { RequirementOutcome } from './write-tx.js';

// One tool, one read, each one object: the chat adapter pins the session's projectId and drops
// undeclared keys by the schema's top-level properties (assistant/tools/mcp-adapter.ts:buildToolset).
// A list and a get behind one `action` asked the model for a field the other act takes, and it
// filled it ("REQ-1" on a list), so the list and the get are two tools.
const listInput = z.strictObject({ projectId: z.uuid() });
const getInput = z.strictObject({
  projectId: z.uuid(),
  requirement: z
    .string()
    .regex(/^REQ-\d+$/, 'a requirement is named by its key, REQ-n')
    .describe('the requirement key, e.g. REQ-12'),
});

type Actor = { userId: string; agency: ReturnType<typeof principalAgency> };
const actorOf = (ctx: Parameters<ContextScopedMcpToolFactory>[0]): Actor => ({
  userId: ctx.principal.userId,
  agency: principalAgency(ctx.principal),
});

export const forgeRequirementsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirements',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    "This project's requirements (REQ-n), as the Requirements screen lists them: each with its state (draft, agreed, in_delivery, delivered, accepted, deferred, dropped), whom it waits on and the act, its BCs proven of total, and its shipped/started/live issues. forge_requirement reads one in full.",
  inputSchema: zodToMcpSchema(listInput),
  handler: async (args) => {
    const { projectId } = listInput.parse(args);
    const list = await listRequirementsAs(actorOf(ctx), projectId);
    return {
      requirements: list.map((r) => ({
        key: r.key,
        title: r.title,
        state: r.standing.state,
        waitingOn: r.standing.waitingOn,
        criteria: {
          proven: r.delivery.criteriaCoverage.passing,
          judged: r.delivery.criteriaCoverage.judged,
          total: r.delivery.criteriaCoverage.criteria,
        },
        issues: {
          shipped: r.delivery.closedIssues,
          started: r.delivery.startedIssues,
          live: r.delivery.liveIssues,
        },
        touchedAt: r.standing.touchedAt,
      })),
    };
  },
});

export const forgeRequirementTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirement',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    "One requirement (`requirement`: REQ-12) as its page reads it: its current revision (goal, scope, BCs), each BC's proof and the issues tracing it, its issues with the release that shipped each, the releases it shipped in, its open tasks, a deferral's reason, and whom it waits on.",
  inputSchema: zodToMcpSchema(getInput),
  handler: async (args) => {
    const { projectId, requirement } = getInput.parse(args);
    const r = await readRequirementAs(actorOf(ctx), projectId, requirement, MCP_DOOR);
    const current = r.revisions.find((v) => v.revision === r.currentRevision) ?? r.revisions[0];
    return {
      key: r.key,
      title: r.title,
      state: r.standing.state,
      waitingOn: r.standing.waitingOn,
      tasks: r.standing.tasks,
      currentRevision: r.currentRevision,
      revisions: r.revisions.length,
      spec: current?.spec ?? null,
      tldr: current?.tldr ?? null,
      coverage: r.standing.coverage,
      issues: r.issues.map((i) => ({
        key: i.displayId,
        title: i.title,
        status: i.status,
        shippedIn: i.shippedIn,
      })),
      releases: r.releases,
      deferral: r.deferral,
      lastAgreed: r.baselines[0]
        ? { by: r.baselines[0].agreedByName, at: r.baselines[0].agreedAt }
        : null,
    };
  },
});

// A BA's or an owner's wish about how the product should behave, recorded from a chat as a draft
// Requirement or a draft revision of one (owner ruling 2026-10-08): never an issue, and only after
// the person confirmed what the chat restated. Both land at draft; a person proposes and accepts.
const requirementKey = z
  .string()
  .regex(/^REQ-\d+$/, 'a requirement is named by its key, REQ-n')
  .describe('the requirement key, e.g. REQ-12');
const draftInput = z.strictObject({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(500),
  ...revisionFields,
});
const reviseInput = z.strictObject({
  projectId: z.uuid(),
  requirement: requirementKey,
  baseRevision: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('the head revision you read with forge_requirement (currentRevision)'),
  ...revisionFields,
});

function drafted(outcome: RequirementOutcome) {
  if (!outcome.ok) return refusedAnswer(outcome.refusals, 'REQUIREMENT_REFUSED');
  const r = outcome.requirement;
  return {
    requirement: { key: r.key, title: r.title, state: r.standing.state },
    revisions: r.revisions.map((v) => ({ revision: v.revision, state: v.state })),
  };
}

const WRITE_RULE =
  'Write only after the person confirmed what you restated, or told you to just record it. Criteria are statements a person can check; what the input leaves unsettled goes in spec.openQuestions, never settled by you.';

export const forgeRequirementDraftTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirement_draft',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: `Draft a NEW requirement (REQ-n at revision 1, draft) for a wish about how the product should behave that no existing requirement covers — look with forge_requirements first, and revise the one that covers it instead. ${WRITE_RULE}`,
  inputSchema: zodToMcpSchema(draftInput),
  handler: async (args) => {
    const { projectId, title, ...write } = draftInput.parse(args);
    return drafted(await createRequirement({ projectId, actor: actorOf(ctx), title, write }));
  },
});

export const forgeRequirementReviseTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirement_revise',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: `Draft a revision of an EXISTING requirement (REQ-n) a wish changes: read it with forge_requirement first and write the whole revision on top of its head — every criterion that stays, kept with its code, plus the change. ${WRITE_RULE}`,
  inputSchema: zodToMcpSchema(reviseInput),
  handler: async (args) => {
    const { projectId, requirement, baseRevision, ...write } = reviseInput.parse(args);
    return drafted(
      await writeRevision({
        projectId,
        ref: requirement,
        actor: actorOf(ctx),
        baseRevision,
        write,
      }),
    );
  },
});
