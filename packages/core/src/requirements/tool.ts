import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { listRequirementsAs, readRequirementAs } from './read.js';

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
