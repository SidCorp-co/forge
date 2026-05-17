'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui';
import type { DependencyEdge } from '@/features/issue/api/issue-api';
import { useIssueDependencies } from '@/features/issue/hooks/use-issue-dependencies';
import { useIssue } from '@/features/issue/hooks/use-issues';

interface IssueDecompositionPanelProps {
  issueId: string;
  projectSlug: string;
}

/**
 * ISS-119 — surfaces the decomposition children of an epic (outgoing
 * `decomposes` edges). Renders the children inline with status dots and
 * ISS-N links so a reviewer can see at a glance how far each slice has
 * progressed. The relations panel still lists the same edges; this panel
 * exists because epic decomposition warrants higher visibility than a
 * generic relation row.
 *
 * Hides itself when the issue has no decomposes-outgoing edges, so the
 * panel only takes up sidebar space on actual parent epics.
 */
export function IssueDecompositionPanel({ issueId, projectSlug }: IssueDecompositionPanelProps) {
  const deps = useIssueDependencies(issueId);

  if (deps.isLoading) {
    return null;
  }

  const children = (deps.data?.outgoing ?? []).filter(
    (edge: DependencyEdge) => edge.kind === 'decomposes',
  );
  if (children.length === 0) return null;

  return (
    <section
      id="issue-decomposition"
      className="rounded-sm border border-outline-variant/20 bg-surface"
    >
      <div className="flex items-center justify-between border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Decomposition children ({children.length})
        </h3>
      </div>
      <IntegrationBranchSubtitle firstChildId={children[0]?.toIssueId} />
      <ul className="space-y-1 p-4">
        {children.map((edge) => (
          <DecompositionChildRow
            key={edge.id}
            childIssueId={edge.toIssueId}
            projectSlug={projectSlug}
          />
        ))}
      </ul>
    </section>
  );
}

// ISS-138 (PR-D) — surfaces the integration branch name when at least one
// child carries a per-issue branchConfig override. We read it from the first
// child rather than the parent's metadata so the subtitle reflects what
// forge-code will actually check out (PR-A's resolver order).
function IntegrationBranchSubtitle({ firstChildId }: { firstChildId: string | undefined }) {
  const child = useIssue(firstChildId);
  if (!child.data) return null;
  const meta = (child.data as { metadata?: { branchConfig?: { baseBranch?: string | null } | null } | null })
    .metadata;
  const branch = meta?.branchConfig?.baseBranch;
  if (!branch) return null;
  return (
    <div className="border-b border-outline-variant/10 px-4 py-2 text-xs text-on-surface-variant">
      Integration branch: <code className="font-mono text-on-surface">{branch}</code>
    </div>
  );
}

interface DecompositionChildRowProps {
  childIssueId: string;
  projectSlug: string;
}

function DecompositionChildRow({ childIssueId, projectSlug }: DecompositionChildRowProps) {
  const issue = useIssue(childIssueId);

  if (issue.isLoading || !issue.data) {
    return (
      <li className="flex items-center gap-2 text-sm">
        <Skeleton className="h-4 w-32" />
      </li>
    );
  }

  const data = issue.data;
  return (
    <li className="flex items-center gap-2 text-sm">
      <StatusDot status={data.status} />
      <Link
        href={`/projects/${projectSlug}/issues/${data.displayId ?? childIssueId}`}
        className="flex min-w-0 items-center gap-2 hover:underline"
      >
        <span className="font-mono text-[10px] text-primary">{data.displayId ?? childIssueId.slice(0, 8)}</span>
        <span className="truncate text-on-surface">{data.title}</span>
      </Link>
    </li>
  );
}

const STATUS_COLOR: Record<string, string> = {
  open: 'bg-outline',
  confirmed: 'bg-outline',
  waiting: 'bg-amber-500',
  approved: 'bg-blue-500',
  in_progress: 'bg-blue-500',
  developed: 'bg-violet-500',
  deploying: 'bg-violet-500',
  testing: 'bg-violet-500',
  tested: 'bg-emerald-500',
  pass: 'bg-emerald-500',
  staging: 'bg-emerald-500',
  released: 'bg-green-600',
  closed: 'bg-on-surface-variant',
  reopen: 'bg-amber-500',
  on_hold: 'bg-amber-500',
  needs_info: 'bg-amber-500',
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? 'bg-outline';
  return (
    <span
      aria-label={status}
      title={status}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
    />
  );
}
