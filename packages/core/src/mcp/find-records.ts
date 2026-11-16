/**
 * The records half of `forge_find` (ISS-1256): beside the actions that match what a client wants to
 * do, the records of one project that match its words, in the ranks the REST find answers
 * (`find/service.ts:runFind`), so an agent and a person searching the same words see the same order.
 * The project is the one the client names, else the one its token is bound to, else the only one it
 * reads; with none of those it is asked to name one. A hit is opened with `fetch { id }`, which
 * records the read whoever opens it: against the run a box token names, else outside any run.
 */

import { FIND_LIMIT, type FindHit, type FindType } from '@forge/contracts/find';
import { scrubSecretsDeep } from '@forge/observability';
import { type FindOutcome, openHit, runFind } from '../find/index.js';
import { type EgressSurface, egressShown } from '../lib/data-egress.js';
import { RefusalError } from '../lib/refusal.js';
import { loadVisibleProjectIdsForPrincipal, projectReaderOf } from '../lib/tool.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import { recordOpened, sourcesOf } from '../run-context/index.js';

/** A hit as `forge_find` lists it: what an agent reads to choose one, never its whole text. */
type ListedHit = Pick<
  FindHit,
  'id' | 'type' | 'key' | 'title' | 'excerpt' | 'path' | 'module' | 'status' | 'match'
>;

export interface FoundRecords {
  projectId: string;
  expanded: FindOutcome['result']['expanded'];
  records: ListedHit[];
  gap: boolean;
  degraded: boolean;
  open: string;
}

const listed = ({ id, type, key, title, excerpt, path, module, status, match }: FindHit) => ({
  id,
  type,
  key,
  title,
  excerpt,
  path,
  module,
  status,
  match,
});

/** The project a find runs in, or the reason none can be named. */
async function projectFor(
  principal: McpPrincipal,
  asked: string | undefined,
): Promise<{ projectId: string } | { none: string }> {
  const visible = await loadVisibleProjectIdsForPrincipal(principal);
  if (asked) {
    return visible.includes(asked)
      ? { projectId: asked }
      : { none: `${asked} is no project this token reads; projects.list names them` };
  }
  if (principal.boundProjectId && visible.includes(principal.boundProjectId)) {
    return { projectId: principal.boundProjectId };
  }
  const [only] = visible;
  if (visible.length === 1 && only) return { projectId: only };
  return { none: 'send projectId to search records; projects.list names the projects you read' };
}

/** One project's records matching `query`, as the find door ranks them. */
export async function findRecords(
  principal: McpPrincipal,
  input: { query: string; projectId?: string; type?: FindType[]; limit?: number },
): Promise<FoundRecords | { recordsSkipped: string }> {
  const project = await projectFor(principal, input.projectId);
  if ('none' in project) return { recordsSkipped: project.none };
  const { result } = await runFind({
    projectId: project.projectId,
    projectIds: [project.projectId],
    query: {
      q: input.query,
      ...(input.type ? { type: input.type } : {}),
      limit: Math.min(input.limit ?? FIND_LIMIT.default, FIND_LIMIT.max),
    },
    reader: projectReaderOf(principal),
    askedBy: principal.agency === 'agent' ? 'agent' : 'person',
  });
  return scrubSecretsDeep({
    projectId: project.projectId,
    expanded: result.expanded,
    records: result.groups.flatMap((g) => g.hits.map(listed)),
    gap: result.gap,
    degraded: result.degraded,
    open: 'fetch { id } reads a record whole and counts the read.',
  });
}

const SURFACE: Partial<Record<FindType, EgressSurface>> = {
  term: 'knowledge',
  rule: 'knowledge',
  knowledge: 'knowledge',
  reference: 'knowledge',
  lesson: 'lessons',
  memory: 'memory',
  decision: 'memory',
  issue: 'issue',
  requirement: 'requirement',
  feedback: 'feedback',
  conversation: 'conversation',
};

/** A find hit read whole over MCP, its read recorded against the token's run where it names one. */
export async function fetchHit(principal: McpPrincipal, id: string) {
  const visible = await loadVisibleProjectIdsForPrincipal(principal);
  const home = principal.boundProjectId ?? visible[0];
  if (!home) {
    throw new RefusalError(
      [{ code: 'FIND_HIT_NOT_FOUND', path: '/id', detail: `${id} names nothing this token reads` }],
      'FIND_HIT_NOT_FOUND',
    );
  }
  // a record of a project the token reads is read, egressed and counted in its own project
  const { opened, found, projectId } = await openHit({ projectId: home, projectIds: visible, id });
  recordOpened(
    {
      projectId,
      userId: principal.userId,
      caller: principal.deviceId
        ? {
            deviceId: principal.deviceId,
            fence: principal.projectIds,
            projectId,
            asked: null,
            tokenId: principal.tokenId,
          }
        : null,
    },
    sourcesOf(found),
  );
  const surface = SURFACE[opened.hit.type];
  const content = surface
    ? await egressShown(
        projectId,
        surface,
        { title: opened.hit.title, text: opened.text },
        opened.hit.type,
      )
    : { title: opened.hit.title, text: opened.text };
  return scrubSecretsDeep({
    id,
    title: content.title,
    text: content.text,
    url: `${webBaseUrl() ?? ''}${opened.url}`,
    metadata: {
      type: opened.hit.type,
      key: opened.hit.key,
      path: opened.hit.path,
      module: opened.hit.module,
      status: opened.hit.status,
    },
  });
}
