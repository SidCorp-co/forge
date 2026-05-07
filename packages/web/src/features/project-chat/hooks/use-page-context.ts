'use client';

import { useParams, usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useIssue, useIssueByDisplay } from '@/features/issue/hooks/use-issues';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import type { PageContext } from '@/features/agent/api';

const ISSUE_RE = /^\/projects\/[^/]+\/issues\/([^/?#]+)/;
const DISPLAY_ID_RE = /^ISS-\d+$/i;

const PAGE_KEYWORDS = [
  'agent',
  'agents',
  'board',
  'issues',
  'knowledge',
  'memory',
  'pm',
  'schedules',
  'settings',
  'skills',
] as const;

type PageKey = (typeof PAGE_KEYWORDS)[number] | 'project';

function deriveBasePage(pathname: string, slug: string): PageKey {
  const base = `/projects/${slug}`;
  if (pathname === base || pathname === `${base}/`) return 'project';
  const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : '';
  const [first] = rest.split('/');
  return (PAGE_KEYWORDS as readonly string[]).includes(first ?? '')
    ? (first as PageKey)
    : 'project';
}

/**
 * Derives a `PageContext` from the current URL so the chat bubble can hand
 * the agent a `[Context: …]` line without the user typing `ISS-XX`. Returns
 * null on `/agent` (the full page already owns the chat surface).
 */
export function usePageContext(): PageContext | null {
  const pathname = usePathname() ?? '';
  const params = useParams<{ slug?: string }>();
  const slug = params.slug ?? '';

  const project = useProjectBySlug(slug);

  const issueMatch = pathname.match(ISSUE_RE);
  const issueParam = issueMatch?.[1];
  const isDisplayId = !!issueParam && DISPLAY_ID_RE.test(issueParam);

  const byUuid = useIssue(issueParam && !isDisplayId ? issueParam : undefined);
  const byDisplay = useIssueByDisplay(
    isDisplayId ? project?.id : undefined,
    isDisplayId ? issueParam : undefined,
  );
  const issue = byUuid.data ?? byDisplay.data ?? null;
  // Don't fire an incomplete `{page:'issue'}` pageContext while the issue
  // query is still loading — the next turn would arrive with `issueId`
  // populated and the dedup in core's `samePageContext` would still re-prepend
  // the header. Skipping until data is in hand keeps the first turn correct.
  const issueQueryLoading = isDisplayId ? byDisplay.isLoading : byUuid.isLoading;

  return useMemo<PageContext | null>(() => {
    if (!slug) return null;
    const page = deriveBasePage(pathname, slug);
    if (page === 'agent') return null;

    if (issueParam) {
      if (!issue && issueQueryLoading) return null;
      const ctx: PageContext = { page: 'issue' };
      if (issue) {
        ctx.issueId = issue.id;
        ctx.issueDisplayId = issue.displayId;
        ctx.issueTitle = issue.title;
        ctx.issueStatus = issue.status;
      } else if (isDisplayId) {
        ctx.issueDisplayId = issueParam.toUpperCase();
      }
      return ctx;
    }

    return { page };
  }, [pathname, slug, issueParam, isDisplayId, issue, issueQueryLoading]);
}
