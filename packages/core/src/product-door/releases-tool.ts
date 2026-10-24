// `forge_releases`: a project's releases as the Releases screen and the release page read them, and
// the two acts a person takes on one — naming it, and deciding the approval it waits on. Every action
// calls the service its REST route calls (`release-batch/version-routes.ts`, `release-page/routes.ts`).

import { RELEASES_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { RELEASE_STATES, type ReleaseState, type ReleaseSummary } from '@forge/contracts/releases';
import { z } from 'zod';
import { readDraftReleaseForecast } from '../forecast/index.js';
import { egressAs } from '../lib/data-egress.js';
import { RefusalError } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { holds } from '../permissions/index.js';
import {
  decideApprovalOfVersion,
  draftReleaseIssueIds,
  listReleases,
  nameReleaseAs,
  parseDecision,
  readRelease,
  releaseToolView,
  type ViewerFacts,
} from '../release-batch/index.js';
import { nameInBackground, readReleasePage, refreshInBackground } from '../release-page/index.js';
import { parseArgs } from './args.js';
import { actorOf, forecastViewerOf, readAccess, readerOf } from './context.js';
import { type Progress, scopeProgress } from './progress.js';
import { runningKeysOf } from './work.js';

const LIST_MAX = 50;

const input = z.strictObject({
  action: z.enum(RELEASES_TOOL_ACTIONS),
  projectId: z.uuid(),
  version: z.string().min(1).max(40).optional().describe('the release version, e.g. 0.3.0'),
  state: z.enum(RELEASE_STATES).optional().describe('list: only releases in this state'),
  limit: z.number().int().min(1).max(LIST_MAX).optional(),
  view: z.string().max(40).optional().describe('page: user (default) or developer'),
  name: z.string().optional().describe('name: the release name, a few words'),
  summary: z.string().optional().describe('name: two or three sentences on what it brings'),
  decision: z.enum(['approve', 'return']).optional(),
  reason: z.string().optional().describe('decide: why; a return must say why'),
});
type Input = z.infer<typeof input>;

const SHAPE =
  '{ action, projectId, version?, state?, limit?, view?, name?, summary?, decision?, reason? }';

const DESCRIPTION = `A project's releases: what shipped, what is drafted, what waits on approval, and the acts a person takes on one. Every answer about a release still moving carries \`progress\`: whether work is running now, and when it is likely done (the forecast's dates), or plainly why there is no date.
- action=list { projectId, state?, limit? }: releases newest first, each with version, state (${RELEASE_STATES.join(' | ')}), name, summary, releasedAt, issue count, requirements, what was verified, and whom it waits on. \`draft\` is the release now gathering issues: how many are still to land, which an agent is working on, and when it is likely in people's hands.
- action=get { projectId, version }: one release in full: what users get (notes by section), the requirements it completes, its issues with their proof, what stands in the way, the approval, every attempt at it.
- action=page { projectId, version, view? }: the release page a reader reads (user view, or developer for the technical notes).
- action=name { projectId, version, name, summary }: name a drafted or cut release. Needs project admin, as cutting does.
- action=decide { projectId, version, decision: approve | return, reason? }: decide the approval request the release run is waiting on. This is a person's act: it needs releases.approve on the project, and an approval is judged by the release approval checklist (refused CHECKLIST_INCOMPLETE naming the gap). A return must say why. Read the release (get) before you decide, and decide only when the person asked you to.`;

async function viewerFactsOf(ctx: McpContext, projectId: string): Promise<ViewerFacts> {
  const access = await readAccess(ctx, projectId);
  return {
    ...actorOf(ctx),
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
  };
}

/** Progress a cut release's state already decides: the run working, a person owed, or done. */
function stateProgress(
  r: Pick<ReleaseSummary, 'state' | 'releasedAt' | 'waitingOn'>,
): Progress | null {
  const wait = r.waitingOn.kind === 'none' ? null : r.waitingOn;
  const waits = wait ? `It waits on ${wait.who}${wait.act ? ` to ${wait.act}` : ''}.` : null;
  const byState: Record<Exclude<ReleaseState, 'draft'>, string> = {
    in_progress:
      'The release run is working on it now. No ETA: the forecast does not time a release run.',
    awaiting_approval: `Not running: ${waits ?? 'it waits on an approver.'} No date while it waits.`,
    returned: `Not running: the approver returned it. ${waits ?? ''} No date while it waits.`,
    shipped: `Shipped${r.releasedAt ? ` on ${r.releasedAt.slice(0, 10)}` : ''}. Nothing runs on it.`,
    failed: 'It failed. Nothing runs on it.',
    aborted: 'It was aborted. Nothing runs on it.',
  };
  if (r.state === 'draft') return null;
  return {
    running: r.state === 'in_progress',
    eta: null,
    says: byState[r.state].replace(/\s+/g, ' ').trim(),
  };
}

/** The draft release's progress from the forecast, read through the egress rule as REST reads it. */
async function draftProgress(ctx: McpContext, projectId: string): Promise<Progress> {
  const access = await readAccess(ctx, projectId);
  const out = await egressAs(
    readerOf(ctx),
    projectId,
    'issue',
    await readDraftReleaseForecast(projectId, forecastViewerOf(ctx, access)),
    'the draft release',
  );
  if (!out.ok) throw new RefusalError([out.refusal], out.refusal.code);
  const running = await runningKeysOf(projectId, await draftReleaseIssueIds(projectId));
  return scopeProgress(out.value, running);
}

async function list(ctx: McpContext, i: Input) {
  const read = await listReleases(i.projectId, await viewerFactsOf(ctx, i.projectId));
  const rows = read.releases.filter((r) => !i.state || r.state === i.state);
  const limit = i.limit ?? 20;
  const draft = await draftProgress(ctx, i.projectId);
  return {
    counts: read.counts,
    production: read.production,
    approvalRequired: read.approvalRequired,
    total: rows.length,
    returned: Math.min(rows.length, limit),
    draft: {
      version: read.releases.find((r) => r.state === 'draft')?.version ?? null,
      progress: draft,
    },
    releases: rows.slice(0, limit).map((r) => ({
      version: r.version,
      state: r.state,
      current: r.current,
      name: r.name,
      summary: r.summary,
      releasedAt: r.releasedAt,
      issueCount: r.issueCount,
      requirements: r.requirements,
      verified: r.verified,
      waitingOn: { who: r.waitingOn.who, act: r.waitingOn.act },
      can: r.can,
      progress: r.state === 'draft' ? draft : stateProgress(r),
    })),
  };
}

async function get(ctx: McpContext, i: Input) {
  const { version } = need(i, 'get', 'version');
  const r = await readRelease(i.projectId, version, await viewerFactsOf(ctx, i.projectId));
  const progress = r.state === 'draft' ? await draftProgress(ctx, i.projectId) : stateProgress(r);
  return { ...releaseToolView(r), can: r.can, progress };
}

async function page(ctx: McpContext, i: Input) {
  const { version } = need(i, 'page', 'version');
  const access = await readAccess(ctx, i.projectId);
  return readReleasePage({
    projectId: i.projectId,
    version,
    view: i.view ?? 'user',
    viewer: {
      ...actorOf(ctx),
      isAdmin: holds(access, 'project.admin'),
      mayApprove: holds(access, 'releases.approve'),
      mayShare: holds(access, 'shares.write'),
    },
    onOwed: refreshInBackground,
    onNamingOwed: nameInBackground,
  });
}

async function name(ctx: McpContext, i: Input) {
  const { version, name, summary } = need(i, 'name', 'version', 'name', 'summary');
  return nameReleaseAs(i.projectId, version, { name, summary }, ctx.principal.userId);
}

async function decide(ctx: McpContext, i: Input) {
  const { version } = need(i, 'decide', 'version', 'decision');
  const decision = parseDecision({
    decision: i.decision,
    ...(i.reason === undefined ? {} : { reason: i.reason }),
  });
  const approval = await decideApprovalOfVersion({
    projectId: i.projectId,
    version,
    userId: ctx.principal.userId,
    decision,
  });
  return { act: decision.decision, version, approval };
}

const ACTIONS = { list, get, page, name, decide } as const;

export const forgeReleasesProductTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_releases',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  reach: 'project',
  route: '/api/projects',
  grant: {
    byAction: {
      list: 'projects:read',
      get: 'projects:read',
      page: 'projects:read',
      name: 'projects:write',
      decide: 'projects:write',
    },
  },
  handler: async (args) => {
    const i = parseArgs(input, args, SHAPE);
    return ACTIONS[i.action](ctx, i);
  },
});
