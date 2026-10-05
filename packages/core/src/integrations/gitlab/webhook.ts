/**
 * What a GitLab webhook delivery does (ISS-50): a Push Hook is a push like any host's, a Merge
 * Request Hook writes the change request projection and stamps a merge it reports, and a Pipeline
 * Hook writes the head pipeline onto the projection as the gate's state. Any other event is refused
 * by name — a GitLab hook switched on for events Forge does not read is a configuration to correct,
 * not something to swallow.
 */

import { logger } from '../../lib/logger.js';
import type { InboundFact } from '../index.js';
import {
  applyCheckRunEvent,
  applyPullRequestEvent,
  branchOfPush,
  type ProjectionContext,
  SourceHostCallError,
  SourceHostUnavailable,
} from '../source-host/index.js';
import { buildGitLabClient } from './client.js';
import { landingOf, type MergeRequestBody } from './merge.js';
import { checkStatusOf, conclusionOf } from './status.js';
import type { GitLabConfig, GitLabSecrets } from './types.js';

const GITLAB_EVENTS = ['Push Hook', 'Merge Request Hook', 'Pipeline Hook'] as const;
type GitLabEvent = (typeof GITLAB_EVENTS)[number];

function isGitLabEvent(name: string): name is GitLabEvent {
  return (GITLAB_EVENTS as readonly string[]).includes(name);
}

interface GitLabDeliveryContext {
  projectId: string;
  bindingId: string;
  config: GitLabConfig;
  secrets: GitLabSecrets;
  /** Collected here and emitted by the inbound door for the modules that own each effect. */
  facts: InboundFact[];
}

interface ProjectPart {
  path_with_namespace?: string;
  default_branch?: string;
  web_url?: string;
}

interface PushHook {
  ref?: string;
  after?: string;
  project?: ProjectPart;
}

interface MergeRequestHook {
  project?: ProjectPart;
  object_attributes?: {
    iid?: number;
    title?: string;
    url?: string;
    state?: string;
    action?: string;
    draft?: boolean;
    work_in_progress?: boolean;
    source_branch?: string;
    target_branch?: string;
    last_commit?: { id?: string };
    merge_commit_sha?: string | null;
    squash_commit_sha?: string | null;
    merged_at?: string | null;
    updated_at?: string | null;
  };
}

interface PipelineHook {
  project?: ProjectPart;
  merge_request?: { iid?: number } | null;
  object_attributes?: {
    id?: number;
    name?: string | null;
    sha?: string;
    status?: string;
    created_at?: string | null;
    finished_at?: string | null;
  };
}

interface GitLabEventResult {
  actions: number;
  refusal?: string;
}

/** GitLab writes hook times as `2026-10-02 08:00:00 UTC`; anything else is passed through as sent. */
function gitlabTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const legacy = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/.exec(raw);
  const iso = legacy ? `${legacy[1]}T${legacy[2]}Z` : raw;
  return Number.isNaN(new Date(iso).getTime()) ? null : new Date(iso).toISOString();
}

function projectionOf(ctx: GitLabDeliveryContext): ProjectionContext {
  return { projectId: ctx.projectId, bindingId: ctx.bindingId, host: 'gitlab' };
}

function stateOf(state: string | undefined): 'open' | 'closed' | 'merged' {
  if (state === 'merged') return 'merged';
  return state === 'opened' ? 'open' : 'closed';
}

async function onPush(ctx: GitLabDeliveryContext, payload: PushHook): Promise<GitLabEventResult> {
  const branch = branchOfPush(payload);
  if (!branch) return { actions: 0 };
  ctx.facts.push({
    type: 'source.pushed',
    payload: {
      projectId: ctx.projectId,
      bindingId: ctx.bindingId,
      branch,
      commit: payload.after ?? null,
      defaultBranch: payload.project?.default_branch ?? null,
    },
  });
  return { actions: 1 };
}

/**
 * The merge a hook reports, for the issue's merge stamp. The commit is GitLab's landing (merge
 * commit, else squash, else the fast-forwarded head); the time is `merged_at` where the hook carries
 * it, else the `updated_at` of the `merge` action itself.
 */
function reportMerged(
  ctx: GitLabDeliveryContext,
  mr: NonNullable<MergeRequestHook['object_attributes']>,
): number {
  if (mr.state !== 'merged' || !mr.source_branch) return 0;
  const commitSha = landingOf({
    merge_commit_sha: mr.merge_commit_sha ?? null,
    squash_commit_sha: mr.squash_commit_sha ?? null,
    sha: mr.last_commit?.id ?? null,
  });
  const at = gitlabTime(mr.merged_at) ?? (mr.action === 'merge' ? gitlabTime(mr.updated_at) : null);
  if (!commitSha || !at) return 0;
  ctx.facts.push({
    type: 'source.merged',
    payload: { projectId: ctx.projectId, headRef: mr.source_branch, commitSha, mergedAt: at },
  });
  return 1;
}

/** The merge request's base sha, which the hook does not carry, read from GitLab. */
async function baseShaOf(
  ctx: GitLabDeliveryContext,
  iid: number,
): Promise<string | { refusal: string }> {
  try {
    const client = buildGitLabClient(ctx);
    const read = await client.json<MergeRequestBody>(
      'GET',
      client.project(`/merge_requests/${iid}`),
    );
    const sha = read.diff_refs?.base_sha;
    return sha
      ? sha
      : { refusal: `GitLab reported no diff_refs.base_sha for merge request !${iid}` };
  } catch (err) {
    if (err instanceof SourceHostUnavailable || err instanceof SourceHostCallError) {
      return { refusal: err.message };
    }
    throw err;
  }
}

async function onMergeRequest(
  ctx: GitLabDeliveryContext,
  payload: MergeRequestHook,
): Promise<GitLabEventResult> {
  const mr = payload.object_attributes;
  if (!mr?.iid || !mr.source_branch || !mr.target_branch || !mr.last_commit?.id) {
    return {
      actions: 0,
      refusal:
        'GITLAB_PAYLOAD_INCOMPLETE: the Merge Request Hook carried no iid, branches or last commit, so nothing was recorded',
    };
  }
  const stamped = reportMerged(ctx, mr);
  const base = await baseShaOf(ctx, mr.iid);
  if (typeof base !== 'string') {
    logger.warn(
      { bindingId: ctx.bindingId, iid: mr.iid, why: base.refusal },
      'gitlab: merge request not projected',
    );
    return {
      actions: stamped,
      refusal: `GITLAB_PROJECTION_UNREAD: merge request !${mr.iid} was not written to the projection — ${base.refusal}`,
    };
  }
  const state = stateOf(mr.state);
  const written = await applyPullRequestEvent(projectionOf(ctx), {
    action: mr.action ?? 'update',
    pull_request: {
      number: mr.iid,
      title: mr.title ?? '',
      ...(mr.url ? { html_url: mr.url } : {}),
      state: state === 'open' ? 'open' : 'closed',
      draft: mr.draft === true || mr.work_in_progress === true,
      merged: state === 'merged',
      merged_at:
        state === 'merged' ? (gitlabTime(mr.merged_at) ?? gitlabTime(mr.updated_at)) : null,
      merge_commit_sha:
        state === 'merged'
          ? landingOf({
              merge_commit_sha: mr.merge_commit_sha ?? null,
              squash_commit_sha: mr.squash_commit_sha ?? null,
              sha: mr.last_commit.id,
            })
          : null,
      updated_at: gitlabTime(mr.updated_at),
      head: { ref: mr.source_branch, sha: mr.last_commit.id },
      base: { ref: mr.target_branch, sha: base },
    },
    repository: { full_name: payload.project?.path_with_namespace ?? ctx.config.projectPath ?? '' },
  });
  return { actions: written + stamped };
}

async function onPipeline(
  ctx: GitLabDeliveryContext,
  payload: PipelineHook,
): Promise<GitLabEventResult> {
  const p = payload.object_attributes;
  if (!p?.id || !p.sha || !p.status) {
    return {
      actions: 0,
      refusal:
        'GITLAB_PAYLOAD_INCOMPLETE: the Pipeline Hook carried no id, sha or status, so nothing was recorded',
    };
  }
  const web = payload.project?.web_url;
  const iid = payload.merge_request?.iid;
  const actions = await applyCheckRunEvent(projectionOf(ctx), {
    check_run: {
      id: p.id,
      name: p.name ?? 'pipeline',
      head_sha: p.sha,
      status: checkStatusOf(p.status),
      conclusion: conclusionOf(p.status),
      details_url: web ? `${web}/-/pipelines/${p.id}` : null,
      started_at: gitlabTime(p.created_at),
      completed_at: gitlabTime(p.finished_at),
      app: { slug: 'gitlab-ci' },
      pull_requests: typeof iid === 'number' ? [{ number: iid }] : [],
    },
  });
  return { actions };
}

export async function handleGitLabEvent(
  ctx: GitLabDeliveryContext,
  eventType: string,
  payload: unknown,
): Promise<GitLabEventResult> {
  if (!isGitLabEvent(eventType)) {
    return {
      actions: 0,
      refusal: `GITLAB_EVENT_UNKNOWN: \`${eventType}\` is not an event Forge reads — it reads ${GITLAB_EVENTS.map((e) => `\`${e}\``).join(', ')}. Untick the others on the project's GitLab webhook; nothing was recorded from this one.`,
    };
  }
  switch (eventType) {
    case 'Push Hook':
      return onPush(ctx, payload as PushHook);
    case 'Merge Request Hook':
      return onMergeRequest(ctx, payload as MergeRequestHook);
    case 'Pipeline Hook':
      return onPipeline(ctx, payload as PipelineHook);
  }
}
