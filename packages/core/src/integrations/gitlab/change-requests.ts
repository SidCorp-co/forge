import type { HostCheck, ReadChangeRequest, SourceHost } from '../source-host/index.js';
import { refuseSourceHostInput } from '../source-host/index.js';
import type { GitLabClient } from './client.js';
import { landingOf, type MergeRequestBody } from './merge.js';
import { checkStatusOf, conclusionOf } from './status.js';

/**
 * GitLab lists a commit's pipelines newest first, so a read cut at this many pages of a hundred drops
 * only the oldest re-runs — which the rollup, counting the latest run per name, never counts anyway.
 */
const PIPELINE_MAX_PAGES = 10;

interface PipelineBody {
  id?: number;
  name?: string | null;
  sha?: string;
  status?: string;
  web_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const COMPLETED = new Set(['success', 'failed', 'canceled', 'skipped']);

/**
 * A pipeline in the shape the Pipeline Hook writes (`webhook.ts:onPipeline`): its id, its name or
 * `pipeline`, app `gitlab-ci`. The list carries no `finished_at`, so a finished pipeline's
 * `updated_at` stands for it — the last change to a finished pipeline is its finishing.
 */
function checkOf(client: GitLabClient, sha: string, p: PipelineBody & { id: number }): HostCheck {
  return {
    id: String(p.id),
    name: p.name ?? 'pipeline',
    app: 'gitlab-ci',
    headSha: p.sha ?? sha,
    status: checkStatusOf(p.status),
    conclusion: conclusionOf(p.status),
    detailsUrl: p.web_url ?? (client.webUrl ? `${client.webUrl}/-/pipelines/${p.id}` : null),
    startedAt: p.created_at ?? null,
    completedAt: COMPLETED.has(p.status ?? '') ? (p.updated_at ?? null) : null,
  };
}

function stateOf(state: string | undefined): string {
  if (state === 'opened') return 'open';
  if (state === 'merged') return 'merged';
  return state ? 'closed' : 'open';
}

/** The request as GitLab answered for it, in the port's words; GitLab's own iid is the number. */
export function readOfMergeRequest(mr: MergeRequestBody, iid: number): ReadChangeRequest {
  const state = stateOf(mr.state);
  return {
    number: mr.iid ?? iid,
    url: mr.web_url ?? null,
    title: mr.title ?? '',
    state,
    draft: mr.draft === true || mr.work_in_progress === true,
    headRef: mr.source_branch ?? '',
    headSha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
    baseRef: mr.target_branch ?? '',
    baseSha: mr.diff_refs?.base_sha ?? null,
    updatedAt: mr.updated_at ?? null,
    body: mr.description ?? null,
    mergedAt: state === 'merged' ? (mr.merged_at ?? null) : null,
    mergeCommitSha: state === 'merged' ? landingOf(mr) : null,
  };
}

type ChangeRequestVerbs = Pick<
  SourceHost,
  | 'readChecks'
  | 'readChangeRequestChecks'
  | 'readChangeRequest'
  | 'updateChangeRequest'
  | 'closeChangeRequest'
>;

/**
 * A merge request read, edited or closed by its iid, and a commit's pipelines. GitLab records an
 * outside commit status on a pipeline of its own (`source: external`), so a commit's pipelines are
 * every status it has; its jobs are each pipeline's parts and are not listed beside it.
 */
export function gitlabChangeRequestVerbs(client: GitLabClient): ChangeRequestVerbs {
  const mrPath = (iid: number) => client.project(`/merge_requests/${iid}`);
  const read = async (iid: number) =>
    readOfMergeRequest(await client.json<MergeRequestBody>('GET', mrPath(iid)), iid);

  const readChecks = async (sha: string): Promise<HostCheck[]> => {
    const pipelines = await client.pages<PipelineBody>(
      client.project(`/pipelines?sha=${encodeURIComponent(sha)}`),
      PIPELINE_MAX_PAGES,
    );
    return pipelines.flatMap((p) =>
      typeof p.id === 'number' ? [checkOf(client, sha, { ...p, id: p.id })] : [],
    );
  };

  return {
    readChecks,

    // a merge request pipeline runs at a merge ref, which no `sha` filter on the head finds: the
    // request's own `head_pipeline` is the one GitLab ran for its head, so it is kept at that head
    async readChangeRequestChecks({ number, headSha }) {
      const [atHead, mr] = await Promise.all([
        readChecks(headSha),
        client.json<MergeRequestBody>('GET', mrPath(number)),
      ]);
      const own = mr.head_pipeline;
      if (!own || typeof own.id !== 'number' || atHead.some((c) => c.id === String(own.id))) {
        return atHead;
      }
      return [...atHead, checkOf(client, headSha, { ...own, id: own.id, sha: headSha })];
    },

    readChangeRequest: read,

    async updateChangeRequest({ number, title, body }) {
      const updated = await client.json<MergeRequestBody>('PUT', mrPath(number), {
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { description: body }),
      });
      return readOfMergeRequest(updated, number);
    },

    async closeChangeRequest({ number }) {
      const now = await read(number);
      if (now.state === 'merged') {
        throw refuseSourceHostInput(
          `merge request !${number} on ${client.fullName} is merged, and closing cannot take a landing back — it is left as it is`,
        );
      }
      if (now.state === 'closed') return now;
      const closed = await client.json<MergeRequestBody>('PUT', mrPath(number), {
        state_event: 'close',
      });
      return readOfMergeRequest(closed, number);
    },
  };
}
