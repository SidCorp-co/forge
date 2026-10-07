import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { listRequirementsAs, readRequirementAs } from './read.js';

const input = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), projectId: z.uuid() }),
  z.strictObject({
    action: z.literal('get'),
    projectId: z.uuid(),
    requirement: z.string().regex(/^REQ-\d+$/),
  }),
]);

export const forgeRequirementsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirements',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    'This project\'s requirements (REQ-n), as the Requirements screen reads them. action "list": each with its state (draft, agreed, in_delivery, delivered, accepted, deferred, dropped), whom it waits on and the act, its BCs proven of total, and its shipped/started/live issues. action "get" with `requirement` (REQ-12): its current revision (goal, scope, BCs), each BC\'s proof and the issues tracing it, its issues with the release that shipped each, the releases it shipped in, its open tasks, a deferral\'s reason, and whom it waits on.',
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const parsed = input.parse(args);
    const actor = { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
    if (parsed.action === 'list') {
      const list = await listRequirementsAs(actor, parsed.projectId);
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
    }
    const r = await readRequirementAs(actor, parsed.projectId, parsed.requirement, MCP_DOOR);
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
