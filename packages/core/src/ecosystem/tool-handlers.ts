import { type McpContext, refusedAnswer } from '../lib/tool.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { supersedeBuilderRun } from './builder-supersede.js';
import type { ContractDecision } from './contract/approval.js';
import { decideContractVersion, decidedView } from './contract/decide.js';
import { publishContractVersion } from './contract/publish.js';
import {
  loadContractContext,
  recordContractContext,
  sessionInProject,
} from './contract/run-context-service.js';
import { interfaceView, loadInterface, writeInterface } from './interface-service.js';
import {
  listBuilderRunsAs,
  listLinksAs,
  readBuilderRunAs,
  readLinkAs,
  recordView,
  writtenView,
} from './link-read.js';
import {
  createBuilderRun,
  createLink,
  type RecordOutcome,
  updateBuilderRun,
  updateLink,
} from './link-service.js';
import type { EcosystemRefusal } from './refusals.js';
import type { Action } from './tool-args.js';

export type Answer = Record<string, unknown>;

export const refusedWith = (refusals: readonly EcosystemRefusal[]): Answer =>
  refusedAnswer(refusals, 'ECOSYSTEM_REFUSED');

export const one = (code: EcosystemRefusal['code'], path: string, detail: string) =>
  refusedWith([{ code, path, detail }]);

const recorded = <W extends object>(outcome: RecordOutcome<W>): Answer =>
  outcome.ok ? writtenView(outcome) : refusedWith(outcome.refusals);

type Args = Record<string, unknown> & { baseRevision?: number | null; document?: unknown };

const writerOf = (ctx: McpContext) => ({
  userId: ctx.principal.userId,
  agency: ctx.principal.agency,
});

const writeOf = (ctx: McpContext, a: Args) => ({
  writer: writerOf(ctx),
  baseRevision: a.baseRevision ?? null,
  raw: a.document,
});

// cm:why every service here is the one its REST route calls, so the door changes and the rule does not: the writer is the token's own user and agency, never a field of the document
export const HANDLERS: Record<
  Exclude<Action, 'bus'>,
  (ctx: McpContext, side: string, a: Args) => Promise<Answer>
> = {
  interface: async (ctx, side) => {
    await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(side));
    return interfaceView(side, await loadInterface(side));
  },
  links: async (ctx, side) => {
    const links = await listLinksAs(ctx.principal.userId, side);
    return { links, returned: links.length };
  },
  link: async (ctx, side, a) => readLinkAs(ctx.principal.userId, side, String(a.link)),
  builder_runs: async (ctx, side) => {
    const runs = await listBuilderRunsAs(ctx.principal.userId, side);
    return { runs, returned: runs.length };
  },
  builder_run: async (ctx, side, a) => readBuilderRunAs(ctx.principal.userId, side, String(a.run)),
  context: async (ctx, side, a) => {
    await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(side));
    const session = typeof a.session === 'string' ? a.session : null;
    if (session && !(await sessionInProject(side, session))) {
      return one(
        'ECOSYSTEM_RECORD_NOT_FOUND',
        '/session',
        `project ${side} holds no agent session ${session}`,
      );
    }
    const loaded = await loadContractContext(side, a.paths as string[]);
    if (session && loaded.length) await recordContractContext(session, loaded, 'agent');
    return { loaded, returned: loaded.length, recorded: Boolean(session && loaded.length) };
  },
  interface_write: async (ctx, side, a) => {
    const outcome = await writeInterface({ projectId: side, ...writeOf(ctx, a) });
    if (!outcome.ok) return refusedWith(outcome.refusals);
    return { ...(await interfaceView(side, outcome.held)), created: outcome.created };
  },
  contract_version_publish: async (ctx, side, a) => {
    const out = await publishContractVersion({
      projectId: side,
      writer: writerOf(ctx),
      contract: String(a.contract),
      kind: String(a.kind),
      version: String(a.version),
      artifact: typeof a.source === 'string' ? a.source : JSON.stringify(a.source),
      sourceRef: String(a.sourceRef),
    });
    if (!out.ok) {
      return refusedWith(
        out.refusals.map((r) => (r.path === '/artifact' ? { ...r, path: '/source' } : r)),
      );
    }
    return { recorded: out.recorded, version: out.version };
  },
  contract_version_decide: async (ctx, side, a) => {
    const out = await decideContractVersion({
      projectId: side,
      contract: String(a.contract),
      version: String(a.version),
      decision: a.decision as ContractDecision,
      reason: typeof a.reason === 'string' ? a.reason : null,
      actor: writerOf(ctx),
    });
    return out.ok ? decidedView(out) : refusedWith(out.refusals);
  },
  link_create: async (ctx, side, a) =>
    recorded(await createLink({ projectId: side, ...writeOf(ctx, a) })),
  link_update: async (ctx, side, a) =>
    recorded(await updateLink({ projectId: side, id: String(a.link), ...writeOf(ctx, a) })),
  builder_run_create: async (ctx, side, a) =>
    recorded(await createBuilderRun({ projectId: side, ...writeOf(ctx, a) })),
  builder_run_update: async (ctx, side, a) =>
    recorded(await updateBuilderRun({ projectId: side, id: String(a.run), ...writeOf(ctx, a) })),
  builder_run_supersede: async (ctx, side, a) => {
    const outcome = await supersedeBuilderRun({
      runId: String(a.run),
      projectId: side,
      actor: writerOf(ctx),
      reason: a.reason,
    });
    if (!outcome.ok) return refusedWith(outcome.refusals);
    return { superseded: recordView(outcome.superseded), opened: recordView(outcome.opened) };
  },
};
