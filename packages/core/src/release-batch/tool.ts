import { RELEASE_STATES, type ReleaseDetail } from '@forge/contracts/releases';
import { sayEn } from '@forge/contracts/said';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { holds, requireHeld } from '../permissions/index.js';
import { listReleases, readRelease } from './release-read.js';

const RELEASES_LIST_MAX = 50;

// One tool, one read, each one object: the chat adapter pins the session's projectId and drops
// undeclared keys by the schema's top-level properties (assistant/tools/mcp-adapter.ts:buildToolset).
// A list and a get behind one `action` asked the model for a field the other act takes, and it
// filled it (`version: "x"` on a list), so the list and the get are two tools.
const listInput = z.strictObject({
  projectId: z.uuid(),
  state: z.enum(RELEASE_STATES).optional().describe('only releases in this state'),
  limit: z.number().int().min(1).max(RELEASES_LIST_MAX).optional(),
});
const getInput = z.strictObject({
  projectId: z.uuid(),
  version: z.string().min(1).describe('the release version, e.g. 0.3.0'),
});

/** The reader, with the grants that make a release's waiting act theirs; refused without project.read. */
async function viewerOf(ctx: Parameters<ContextScopedMcpToolFactory>[0], projectId: string) {
  const userId = ctx.principal.userId;
  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');
  return {
    userId,
    agency: principalAgency(ctx.principal),
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
  };
}

export const forgeReleasesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_releases',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `This project's releases, as the Releases screen lists them, newest first (optionally one \`state\`: ${RELEASE_STATES.join(' | ')}), each with version, state, releasedAt, headline, issue count, requirements, what was verified (criteria proven of total, and how the deploy was checked) and whom it waits on. forge_release reads one in full.`,
  inputSchema: zodToMcpSchema(listInput),
  handler: async (args) => {
    const parsed = listInput.parse(args);
    const viewer = await viewerOf(ctx, parsed.projectId);
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

export const forgeReleaseTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_release',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    'One release (`version`: 0.3.0), for the one a person asks about — never once per listed release; the list and forge_project_status already say what each carries. As its page reads it: what users get (the user-facing notes by section; approved designs apart), the requirements it completes or advances, its issues with their proof, what stands in the way, the approval, and what was verified. `attempts` holds every cut of it, each with its roster, the refusal that ended it (code, meaning, words), the abort reason and what carries it; `attempt` is the one wearing the asked version and `continuedAs` where its roster went on — read them for why a version was cancelled or failed.',
  inputSchema: zodToMcpSchema(getInput),
  handler: async (args) => {
    const { projectId, version } = getInput.parse(args);
    return releaseToolView(await readRelease(projectId, version, await viewerOf(ctx, projectId)));
  },
});

/**
 * The one release as the assistant reads it, with every attempt at it: what each was cut with, the
 * refusal that ended it (code, meaning, words) and the abort reason or carried note, so "why was
 * 0.4.0 cancelled" is answered from the record. `attempt` is the one wearing the asked version.
 */
export function releaseToolView(r: ReleaseDetail) {
  const attempts = r.cuts.map((c) => ({
    n: c.n,
    version: c.version,
    outcome: c.outcome,
    cutAt: c.cutAt,
    endedAt: c.endedAt,
    endedBy: c.decidedBy?.name ?? null,
    refusal: c.refusal
      ? { code: c.refusal.code, meaning: sayEn(c.refusal.says), text: c.refusal.text }
      : null,
    abortReason: c.abortReason,
    carried: c.carried,
    roster: c.roster.map((i) => i.key),
  }));
  return {
    version: r.version,
    state: r.state,
    releasedAt: r.releasedAt,
    continuedAs: r.continuedAs,
    attempt: attempts.find((a) => a.version === r.version) ?? null,
    attempts,
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
