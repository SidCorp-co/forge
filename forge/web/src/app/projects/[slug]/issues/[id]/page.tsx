'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Markdown } from '@/components/ui/markdown';
import {
  issueKeys,
  useIssue,
  useIssueByDisplay,
  useTransitionIssue,
} from '@/features/issue/hooks/use-issues';
import { useProjectBySlug, useProjects } from '@/features/project/hooks/use-projects';
import { apiClient } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { ALL_STATUSES } from '@/lib/constants';

const DISPLAY_ID_RE = /^ISS-\d+$/i;

interface CoreComment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const commentsKey = (issueId: string | undefined) =>
  ['issue', issueId, 'comments'] as const;

/**
 * ISS-247: minimum interactive issue detail. Renders the core fields plus
 * a status transition select, comment list (live from
 * /api/issues/:id/comments), and a comment editor that POSTs to the same
 * route. Activity, attachments, agent sessions and relations remain
 * placeholder until their core endpoints populate real data.
 *
 * The `[id]` segment accepts either a uuid (from internal list links) or a
 * displayId like `ISS-12` (for shareable deep-links). DisplayId is resolved
 * project-scoped via `/api/projects/:projectId/issues/by-display/:displayId`.
 */
export default function IssueDetailPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const isDisplayId = DISPLAY_ID_RE.test(id);

  // useProjectBySlug returns null for both "still loading" and "not a member /
  // unknown slug" — fall back to useProjects().isLoading to disambiguate so we
  // don't sit on the loading spinner forever for a bad slug.
  const projectsQuery = useProjects();
  const project = useProjectBySlug(isDisplayId ? slug : undefined);
  const projectId = project?.id;
  const projectMissing = isDisplayId && !projectsQuery.isLoading && !projectId;

  const byUuid = useIssue(isDisplayId ? undefined : id);
  const byDisplay = useIssueByDisplay(
    isDisplayId ? projectId : undefined,
    isDisplayId ? id : undefined,
  );

  const issue = isDisplayId ? byDisplay.data : byUuid.data;
  const error = isDisplayId ? byDisplay.error : byUuid.error;
  const isLoading = isDisplayId
    ? !projectMissing && (projectsQuery.isLoading || (!!projectId && byDisplay.isLoading))
    : byUuid.isLoading;

  const transitionIssue = useTransitionIssue();
  const qc = useQueryClient();
  const issueId = issue?.id;

  const commentsQuery = useQuery({
    queryKey: commentsKey(issueId),
    queryFn: () => apiClient<CoreComment[]>(`/issues/${issueId}/comments?limit=100`),
    enabled: !!issueId,
  });

  const [draft, setDraft] = useState('');
  const createComment = useMutation({
    mutationFn: (body: string) =>
      apiClient<CoreComment>(`/issues/${issueId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: commentsKey(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.details });
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 text-center text-xs font-mono text-outline-variant">
        LOADING ISSUE_DATA…
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="p-8 text-center bg-surface text-on-surface">
        <p className="mb-2 text-[10px] uppercase tracking-widest text-danger font-bold">
          {error ? formatApiError(error) : 'Issue not found'}
        </p>
        <Link
          href={`/projects/${slug}/issues`}
          className="text-xs uppercase hover:underline text-on-surface-variant"
        >
          ← Back to issues
        </Link>
      </div>
    );
  }

  const transitionError = transitionIssue.error;
  const commentError = createComment.error;
  const comments = commentsQuery.data ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 space-y-6">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-outline">
        <Link
          href={`/projects/${slug}/issues`}
          className="transition-colors hover:text-on-surface"
        >
          Issues
        </Link>
        <span className="text-outline-variant">/</span>
        <span className="font-mono text-primary tracking-widest">{issue.displayId}</span>
      </div>

      <h1 className="text-2xl font-bold text-primary">{issue.title}</h1>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-outline-variant">
          Status
          <select
            value={issue.status}
            disabled={transitionIssue.isPending}
            onChange={(e) =>
              transitionIssue.mutate({ id: issue.id, toStatus: e.currentTarget.value })
            }
            className="rounded-sm border border-outline-variant/30 bg-surface-container-high px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface focus:outline-none focus:border-primary disabled:opacity-50"
          >
            {ALL_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
          {issue.priority}
        </span>
        {issue.category && (
          <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
            {issue.category}
          </span>
        )}
      </div>
      {transitionError && (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(transitionError)}
        </p>
      )}

      {issue.labels && issue.labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-outline-variant">
            Labels
          </span>
          {issue.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[10px] font-medium"
              style={l.color ? { borderColor: l.color, color: l.color } : undefined}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      <section className="rounded-sm border border-outline-variant/20 bg-surface">
        <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Description
          </h3>
        </div>
        <div className="p-5 text-sm text-on-surface">
          {issue.description ? (
            <Markdown>{issue.description}</Markdown>
          ) : (
            <span className="text-outline">No description provided</span>
          )}
        </div>
      </section>

      <section className="rounded-sm border border-outline-variant/20 bg-surface">
        <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Comments
          </h3>
        </div>
        <div className="space-y-4 p-5 text-sm">
          {commentsQuery.isLoading ? (
            <span className="text-outline">Loading comments…</span>
          ) : comments.length === 0 ? (
            <span className="text-outline">No comments yet</span>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-3"
                >
                  <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-outline">
                    <span className="font-mono">{c.authorId.slice(0, 8)}</span>
                    <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time>
                  </div>
                  <Markdown>{c.body}</Markdown>
                </li>
              ))}
            </ul>
          )}

          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const body = draft.trim();
              if (!body) return;
              createComment.mutate(body);
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a comment — markdown supported"
              rows={3}
              className="w-full resize-y rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
            />
            {commentError && (
              <p className="text-[10px] uppercase tracking-widest text-error">
                {formatApiError(commentError)}
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={createComment.isPending || !draft.trim()}
                className="rounded-sm border border-outline-variant/30 bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-primary/90 disabled:opacity-50"
              >
                {createComment.isPending ? 'Posting…' : 'Post comment'}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="rounded-sm border border-outline-variant/20 bg-surface">
        <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Activity
          </h3>
        </div>
        <div className="p-5 text-sm">
          {issue.activity && issue.activity.length > 0 ? (
            <span className="text-outline">
              {issue.activity.length} entr{issue.activity.length === 1 ? 'y' : 'ies'}
            </span>
          ) : (
            <span className="text-outline">
              Activity log + attachments + relations land in a follow-up.
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
