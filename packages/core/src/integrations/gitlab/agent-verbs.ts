import { SourceHostCallError, SourceHostInputRefusal } from '../source-host/errors.js';
import type { CheckLog, SourceHost } from '../source-host/types.js';
import type { GitLabClient } from './client.js';
import type { MergeRequestBody } from './merge.js';
import { checkStatusOf, conclusionOf } from './status.js';

const DIFF_CAP_BYTES = 256 * 1024;
const DIFF_MAX_PAGES = 10;
const LOG_CAP_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOG_LINES = 100;

interface JobBody {
  id?: number;
  name?: string;
  status?: string;
  stage?: string;
  web_url?: string | null;
  failure_reason?: string | null;
}

interface UserBody {
  id?: number;
  username?: string;
}

const enc = encodeURIComponent;

function tail(text: string, lines: number): { text: string; truncated: boolean } {
  const all = text.split('\n');
  if (all.length <= lines) return { text, truncated: false };
  return { text: all.slice(all.length - lines).join('\n'), truncated: true };
}

function mergeRequestUrl(client: GitLabClient, iid: number): string | null {
  return client.webUrl ? `${client.webUrl}/-/merge_requests/${iid}` : null;
}

type AgentVerbs = Pick<
  SourceHost,
  'diff' | 'checkLog' | 'comment' | 'openChangeRequest' | 'requestReview' | 'submitReview'
>;

/** The judgement verbs on a GitLab merge request: notes, reviewers, approvals, a diff, a job trace. */
export function gitlabAgentVerbs(
  client: GitLabClient,
  branchHead: (branch: string) => Promise<string>,
): AgentVerbs {
  const mrPath = (iid: number, suffix = '') => client.project(`/merge_requests/${iid}${suffix}`);
  let me: Promise<UserBody> | null = null;
  const whoAmI = () => {
    me ??= client.json<UserBody>('GET', '/user');
    return me;
  };
  const note = (iid: number, body: string) =>
    client.json<{ id?: number; created_at?: string | null }>('POST', mrPath(iid, '/notes'), {
      body,
    });

  return {
    async diff({ number, maxBytes }) {
      const files = await client.pages<{ old_path?: string; new_path?: string; diff?: string }>(
        mrPath(number, '/diffs'),
        DIFF_MAX_PAGES,
      );
      const whole = client.scrub(
        files
          .map(
            (f) =>
              `diff --git a/${f.old_path} b/${f.new_path}\n--- a/${f.old_path}\n+++ b/${f.new_path}\n${f.diff ?? ''}`,
          )
          .join(''),
      );
      const cap = maxBytes ?? DIFF_CAP_BYTES;
      const buf = Buffer.from(whole, 'utf8');
      const truncated = buf.byteLength > cap;
      return {
        number,
        repository: client.fullName,
        bytes: buf.byteLength,
        truncated,
        diff: truncated ? buf.subarray(0, cap).toString('utf8') : whole,
      };
    },

    async checkLog({ checkRunId, lines }): Promise<CheckLog> {
      const job = await client.json<JobBody>('GET', client.project(`/jobs/${checkRunId}`));
      const base = {
        checkRunId,
        name: job.name ?? '(unnamed job)',
        app: 'gitlab-ci',
        status: checkStatusOf(job.status),
        conclusion: conclusionOf(job.status),
        detailsUrl: job.web_url ?? null,
        summary: job.failure_reason ?? null,
      };
      let raw: { body: string; bytes: number; truncated: boolean };
      try {
        raw = await client.text(client.project(`/jobs/${checkRunId}/trace`), LOG_CAP_BYTES, 'tail');
      } catch (err) {
        if (err instanceof SourceHostCallError) {
          return {
            ...base,
            log: null,
            truncated: false,
            refusal: `GitLab answered HTTP ${err.status} for the trace of job ${checkRunId} — a 404 is a trace GitLab has erased or a job it has removed, a 403 a permission the token does not hold on ${client.fullName}. Nothing was retried.`,
          };
        }
        throw err;
      }
      const tailed = tail(raw.body, lines ?? DEFAULT_LOG_LINES);
      return {
        ...base,
        log: tailed.text,
        truncated: tailed.truncated || raw.truncated,
        refusal: null,
      };
    },

    async comment({ number, body }) {
      const written = await note(number, body);
      const url = mergeRequestUrl(client, number);
      return {
        commentId: written.id ?? 0,
        url: url && written.id ? `${url}#note_${written.id}` : url,
      };
    },

    async openChangeRequest(args) {
      const made = await client.json<MergeRequestBody>('POST', client.project('/merge_requests'), {
        source_branch: args.head,
        target_branch: args.base,
        title: args.draft ? `Draft: ${args.title}` : args.title,
        ...(args.body === undefined ? {} : { description: args.body }),
      });
      // cm:why GitLab computes diff_refs after it answers the create, so a new request can arrive without a base sha; the target branch's head is what that request was opened against
      const baseSha =
        made.diff_refs?.base_sha ?? (await branchHead(made.target_branch ?? args.base));
      return {
        number: made.iid ?? 0,
        url: made.web_url ?? null,
        title: made.title ?? args.title,
        state: made.state === 'opened' ? 'open' : (made.state ?? 'open'),
        draft: made.draft === true,
        headRef: made.source_branch ?? args.head,
        headSha: made.sha ?? made.diff_refs?.head_sha ?? null,
        baseRef: made.target_branch ?? args.base,
        baseSha,
        updatedAt: made.updated_at ?? null,
      };
    },

    async requestReview({ number, reviewers, teamReviewers }) {
      if (teamReviewers?.length) {
        throw new SourceHostInputRefusal(
          `GitLab has no team reviewers, so \`teamReviewers\` (${teamReviewers.join(', ')}) cannot be requested on !${number} — name GitLab usernames in \`reviewers\``,
        );
      }
      const ids: number[] = [];
      for (const username of reviewers ?? []) {
        const found = await client.json<UserBody[]>('GET', `/users?username=${enc(username)}`);
        const id = found[0]?.id;
        if (!id) {
          throw new SourceHostInputRefusal(
            `GitLab knows no user \`${username}\`, so nobody was asked to review !${number}`,
          );
        }
        ids.push(id);
      }
      const current = await client.json<{ reviewers?: UserBody[] }>('GET', mrPath(number));
      const held = (current.reviewers ?? []).flatMap((r) => (r.id ? [r.id] : []));
      const updated = await client.json<{ reviewers?: UserBody[] }>('PUT', mrPath(number), {
        reviewer_ids: [...new Set([...held, ...ids])],
      });
      return {
        number,
        requestedReviewers: (updated.reviewers ?? []).flatMap((r) =>
          r.username ? [r.username] : [],
        ),
        requestedTeams: [],
      };
    },

    async submitReview({ number, event, body }) {
      if (event === 'REQUEST_CHANGES') {
        throw new SourceHostInputRefusal(
          `GitLab's REST API has no request-changes verdict, so it is refused rather than written as something near it — leave !${number} unapproved and say what has to change with \`comment\``,
        );
      }
      const mr = await client.json<MergeRequestBody>('GET', mrPath(number));
      if (event === 'APPROVE') {
        await client.json('POST', mrPath(number, '/approve'), mr.sha ? { sha: mr.sha } : {});
      }
      const written = await note(number, body);
      const url = mergeRequestUrl(client, number);
      return {
        reviewId: written.id ?? 0,
        state: event === 'APPROVE' ? 'approved' : 'commented',
        url: url && written.id ? `${url}#note_${written.id}` : url,
        submittedAt: written.created_at ?? null,
        reviewer: (await whoAmI()).username ?? '(the GitLab token)',
        headRef: mr.source_branch ?? '',
        number,
        repository: client.fullName,
      };
    },
  };
}
