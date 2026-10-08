// web-v2 feature module: projects — pure derivation helpers.
//
// All functions here are pure (no React, no I/O) so the console's business
// logic — health derivation, list↔health join, totals, sort, filter — is unit
// testable in `derive.test.ts` without rendering anything.
import type { HealthKey } from '@/design';
import type { QueryRead } from '@/design/patterns/badge-read';
import type {
  ProjectConsoleItem,
  ProjectHealthRow,
  ProjectListItem,
  ProjectSort,
  WorkspaceTotals,
} from './types';

/** Health states that count as "needs attention" (banner + filter + sort). */
const ATTENTION_HEALTH: ReadonlySet<HealthKey> = new Set<HealthKey>(['attention', 'down']);

/** A project whose health was not read is not one the console can say needs attention. */
export function isAttention(item: Pick<ProjectConsoleItem, 'health'>): boolean {
  return item.health !== null && ATTENTION_HEALTH.has(item.health);
}

export function deriveHealth(
  h: Pick<
    ProjectHealthRow,
    'blockers' | 'pendingEscalations' | 'runnerCount' | 'totalActive' | 'liveRuns'
  >,
): HealthKey {
  if ((h.blockers?.length ?? 0) > 0 || (h.pendingEscalations ?? 0) > 0) return 'attention';
  if (h.runnerCount === 0 && (h.totalActive > 0 || h.liveRuns > 0)) return 'attention';
  if (h.totalActive === 0 && h.liveRuns === 0) return 'idle';
  return 'healthy';
}

/**
 * Join the `GET /api/projects` list against the `GET /api/projects/health`
 * rollup (by project id), layering the client-only pinned set on top. A list row the
 * read rollup has no row for falls back to zero/idle, so a just-created project still
 * renders; where the read is `pending`, or `failed` over rows still held, no row states one.
 */
export function mergeProjects(
  list: ProjectListItem[],
  health: ProjectHealthRow[] | undefined,
  pinnedIds: ReadonlySet<string>,
  healthRead: QueryRead,
): ProjectConsoleItem[] {
  const healthById = new Map<string, ProjectHealthRow>();
  if (healthRead === 'read') for (const h of health ?? []) healthById.set(h.id, h);

  return list.map((p) => {
    const h = healthById.get(p.id);
    const read = healthRead === 'read';
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      orgId: p.orgId,
      orgName: p.orgName,
      orgIsPersonal: p.orgIsPersonal,
      role: p.role,
      createdAt: p.createdAt,
      description: h?.description ?? null,
      repoPath: h?.repoPath ?? null,
      healthRead,
      health: read ? (h ? deriveHealth(h) : 'idle') : null,
      liveRuns: read ? (h?.liveRuns ?? 0) : null,
      openIssues: read ? (h?.totalActive ?? 0) : null,
      runnerCount: read ? (h?.runnerCount ?? 0) : null,
      spend24hUsd: read ? (h?.spend24hUsd ?? 0) : null,
      memberCount: read ? (h?.memberCount ?? 0) : null,
      members: h?.members ?? [],
      lastActivityAt: h?.lastActivityAt ?? null,
      pinned: pinnedIds.has(p.id),
    };
  });
}

/** Workspace summary across all console items, for the stats band. Its figures are null until the health read is `read`. */
export function workspaceTotals(items: ProjectConsoleItem[], healthRead: QueryRead): WorkspaceTotals {
  if (healthRead !== 'read') {
    return { projects: items.length, healthRead, liveRuns: null, openIssues: null, runners: null, spend24hUsd: null };
  }
  return items.reduce<WorkspaceTotals>(
    (acc, p) => ({
      projects: acc.projects + 1,
      healthRead,
      liveRuns: (acc.liveRuns ?? 0) + (p.liveRuns ?? 0),
      openIssues: (acc.openIssues ?? 0) + (p.openIssues ?? 0),
      runners: (acc.runners ?? 0) + (p.runnerCount ?? 0),
      spend24hUsd: (acc.spend24hUsd ?? 0) + (p.spend24hUsd ?? 0),
    }),
    { projects: 0, healthRead, liveRuns: 0, openIssues: 0, runners: 0, spend24hUsd: 0 },
  );
}

// Lower rank sorts first under the "health" sort (worst → best).
const HEALTH_RANK: Record<HealthKey | 'unread', number> = { down: 0, attention: 1, healthy: 2, idle: 3, unread: 4 };

/** Most-recent-activity first; nulls (never active) sink to the bottom. */
function recencyKey(item: ProjectConsoleItem): number {
  return item.lastActivityAt ? Date.parse(item.lastActivityAt) : 0;
}

/** Return a new array sorted by the chosen key (non-mutating). */
export function sortProjects(
  items: ProjectConsoleItem[],
  sort: ProjectSort,
): ProjectConsoleItem[] {
  const out = [...items];
  out.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'health') {
      return (HEALTH_RANK[a.health ?? 'unread'] - HEALTH_RANK[b.health ?? 'unread']) || (recencyKey(b) - recencyKey(a));
    }
    return recencyKey(b) - recencyKey(a); // 'recent'
  });
  return out;
}

/** Free-text (name/repo/description) + needs-attention filter. */
export function filterProjects(
  items: ProjectConsoleItem[],
  query: string,
  attentionOnly: boolean,
  orgId: string | null = null,
): ProjectConsoleItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((p) => {
    const matches =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.orgName.toLowerCase().includes(q) ||
      (p.repoPath?.toLowerCase().includes(q) ?? false) ||
      (p.description?.toLowerCase().includes(q) ?? false);
    return matches && (!attentionOnly || isAttention(p)) && (!orgId || p.orgId === orgId);
  });
}

/** `$13.38` — trailing-24h spend, two decimals. */
export function formatSpend(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatCycleTime(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days) || days <= 0) return "—";
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours}h`;
  }
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

/**
 * Compact relative time ("just now", "5m", "3h", "2d", "4w") from an ISO
 * string. `now` is injected so the function stays pure + testable.
 */
export function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return '—';
  const diffMs = now - Date.parse(iso);
  if (Number.isNaN(diffMs)) return '—';
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}
