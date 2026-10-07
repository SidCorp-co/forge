import { RELEASE_STATES } from '@forge/contracts/releases';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { holds, requireHeld } from '../permissions/index.js';
import { listReleases, readRelease } from './release-read.js';

const RELEASES_LIST_MAX = 50;

// One object, not a union: the chat adapter pins the session's projectId and drops undeclared keys
// by the schema's top-level properties (assistant/tools/mcp-adapter.ts:buildToolset), which a union
// has none of. Which fields an action takes is refused by name below instead.
const input = z
  .strictObject({
    action: z.enum(['list', 'get']),
    projectId: z.uuid(),
    version: z
      .string()
      .min(1)
      .optional()
      .describe('action "get" only: the release version, e.g. 0.3.0'),
    state: z.enum(RELEASE_STATES).optional().describe('action "list" only'),
    limit: z.number().int().min(1).max(RELEASES_LIST_MAX).optional().describe('action "list" only'),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'get' && v.version === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'action "get" reads one release: name its `version`, e.g. 0.3.0',
      });
    if (v.action === 'list' && v.version !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'action "list" takes no `version`; use action "get" to read one release',
      });
    if (v.action === 'get' && (v.state !== undefined || v.limit !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: [v.state !== undefined ? 'state' : 'limit'],
        message: 'action "get" takes only `version`; `state` and `limit` filter action "list"',
      });
  });

export const forgeReleasesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_releases',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `This project's releases, as the Releases screen reads them. action "list": newest first (optionally one \`state\`: ${RELEASE_STATES.join(' | ')}), each with version, state, releasedAt, headline, issue count, requirements, what was verified (criteria proven of total, and how the deploy was checked) and whom it waits on. action "get" with \`version\`: one release — what users get (the user-facing notes by section; approved designs apart), the requirements it completes or advances, its issues with their proof, what stands in the way, the approval, and what was verified.`,
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const parsed = input.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(parsed.projectId, userId);
    requireHeld(access, 'project.read');
    const viewer = {
      userId,
      agency: principalAgency(ctx.principal),
      isAdmin: holds(access, 'project.admin'),
      mayApprove: holds(access, 'releases.approve'),
    };
    if (parsed.action === 'get') {
      const r = await readRelease(parsed.projectId, parsed.version as string, viewer);
      return {
        version: r.version,
        state: r.state,
        releasedAt: r.releasedAt,
        headline: r.headline,
        verified: r.verified,
        verifiedBy: r.verifiedBy,
        whatUsersGet: r.notes.sections,
        designsApproved: r.notes.designs,
        withoutNotes: r.notes.withoutNotes,
        requirements: r.requirementsCompleted,
        issues: r.issues.map((i) => ({
          key: i.key,
          title: i.title,
          status: i.status,
          requirement: i.requirement,
          proof: i.proof,
        })),
        feedbackAnswered: r.feedbackAnswered,
        gates: r.gates.map((g) => ({
          code: g.code,
          kind: g.kind,
          sentence: g.sentence,
          owner: g.owner,
        })),
        approval: r.approval,
        waitingOn: r.waitingOn,
      };
    }
    const list = await listReleases(parsed.projectId, viewer);
    const rows = list.releases.filter((r) => !parsed.state || r.state === parsed.state);
    return {
      counts: list.counts,
      returned: Math.min(rows.length, parsed.limit ?? 20),
      total: rows.length,
      production: list.production,
      releases: rows.slice(0, parsed.limit ?? 20).map((r) => ({
        version: r.version,
        state: r.state,
        current: r.current,
        releasedAt: r.releasedAt,
        headline: r.headline,
        issueCount: r.issueCount,
        requirements: r.requirements,
        verified: r.verified,
        waitingOn: r.waitingOn,
      })),
    };
  },
});
