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

/** A project whose health was not read is not one the console can say needs attention, whatever health it still holds. */
export function isAttention(item: Pick<ProjectConsoleItem, 'health' | 'healthRead'>): boolean {
  return item.healthRead === 'read' && item.health !== null && ATTENTION_HEALTH.has(item.health);
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
  return item.healthRead === 'read' && item.lastActivityAt ? Date.parse(item.lastActivityAt) : 0;
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
      const rank = (p: ProjectConsoleItem) => HEALTH_RANK[p.healthRead === 'read' ? (p.health ?? 'unread') : 'unread'];
      return (rank(a) - rank(b)) || (recencyKey(b) - recencyKey(a));
    }
    return recencyKey(b) - recencyKey(a); // 'recent'
  });
  return out;
}

/** Free-text (name/organization, and repo/description where the rollup is read) + needs-attention filter. */
export function filterProjects(
  items: ProjectConsoleItem[],
  query: string,
  attentionOnly: boolean,
  orgId: string | null = null,
): ProjectConsoleItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((p) => {
    // The repository and description come from the health rollup: unread, they are not searched.
    const rollupRead = p.healthRead === 'read';
    const matches =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.orgName.toLowerCase().includes(q) ||
      (rollupRead && (p.repoPath?.toLowerCase().includes(q) ?? false)) ||
      (rollupRead && (p.description?.toLowerCase().includes(q) ?? false));
    return matches && (!attentionOnly || isAttention(p)) && (!orgId || p.orgId === orgId);
  });
}

/**
 * What the console cannot answer while the health rollup is not read, one sentence each: a search
 * reaches the repository and description only through it, the needs-attention filter and the two
 * rollup sorts are made from it. Each is said, so an answer drawn without it is never read as the
 * answer. Empty where the rollup is read.
 */
export function unreadStatements(a: {
  query: string;
  attentionOnly: boolean;
  sort: ProjectSort;
  read: QueryRead;
}): string[] {
  if (a.read === 'read') return [];
  const failed = a.read === 'failed';
  const out: string[] = [];
  if (a.query.trim() !== '') {
    out.push(
      failed
        ? 'The search matches names and organizations only: the repository and description could not be read.'
        : 'The search matches names and organizations only until the repository and description are read.',
    );
  }
  if (a.attentionOnly) {
    out.push(
      failed
        ? 'The needs-attention filter is paused and every project is listed, because which projects need attention could not be read. It applies again once it is read.'
        : 'The needs-attention filter is paused and every project is listed until which projects need attention is read. It applies again then.',
    );
  }
  if (a.sort === 'recent' || a.sort === 'health') {
    const by = a.sort === 'recent' ? 'recent activity' : 'health';
    out.push(
      failed
        ? `Projects are not sorted by ${by}, which could not be read: they are in the order the server sent them.`
        : `Projects are not sorted by ${by} until it is read: they are in the order the server sent them.`,
    );
  }
  return out;
}

/** The answer to a search that matched no name while the repository and description are unread: not "no match". */
export function blindSearchEmpty(query: string, read: QueryRead): string {
  const q = query.trim();
  return read === 'failed'
    ? `Cannot say which projects match "${q}": the repository and description could not be read, and no name or organization matches.`
    : `Cannot say yet which projects match "${q}": the repository and description are still being read, and no name or organization matches.`;
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
