// The project Dashboard (ISS-1067): the one-project view of Activity. One question for one project —
// what needs me, and is the loop moving — answered as one shared grouped list: Needs you (the decisions
// core's who-owes table names a person's, not drawn while none waits), Moving, Shipped and Stuck, then
// one Audit line where a cleanup window is on. Moving and Stuck are the Issues list's own groups from
// its own read, so the two counts never disagree. Each row is a title and one badge; the rest opens on
// its own page. A group holding nothing is not drawn.

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { decisionLineOf } from "@forge/contracts/plain-decision";
import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import type { ReleaseSummary } from "@forge/contracts/releases";
import { useQueries } from "@tanstack/react-query";
import { GroupedList, type ListGroup, type ListRowView, ProjectLoader, StatusBadge, StatusChip, useGroupFold } from "@/design";
import { AuditLine } from "../components/cleanup";
import { issueRowView, issueStandingQuery, useIssueStanding, useRowWords } from "@/features/issues";
import { decisionHref, needsYouDecisionsQuery, useNeedsYouDecisions } from "@/features/needs-you";
import { useShippedReleases } from "@/features/releases";
import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { approvalsHref, questionDecisionHref } from "@/lib/routes/approvals";
import { issuesHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useRouter } from "@/lib/navigation/router";

/** How many rows a group names: the newest releases, the first issues; the rest are one row to their own page. */
export const DASHBOARD_ROWS = 3;

type DashRow =
  | { kind: "decision"; d: NeedsYouDecision }
  /** What a group counts past the rows it names: one row to the page that lists all of them. */
  | { kind: "more"; group: string; n: number; href: string }
  | { kind: "issue"; r: IssueStandingRow }
  | { kind: "release"; r: ReleaseSummary };

const keyOf = (row: DashRow): string =>
  row.kind === "decision" ? `d:${row.d.id}` : row.kind === "more" ? `more:${row.group}` : row.kind === "issue" ? row.r.key : `r:${row.r.version}`;

function decisionPlace(slug: string, d: NeedsYouDecision): string {
  if (d.entity === "question") return questionDecisionHref(slug, d.key);
  return decisionHref(slug, d.opens) ?? approvalsHref(slug);
}

function useRowView(slug: string): (row: DashRow) => ListRowView {
  const t = useCopy();
  const time = useTimeFormat();
  const issue = issueRowView(slug, useRowWords());
  const age = (at: string | null) => (at ? { text: time.age(at), title: time.dateTime(at) } : null);
  return (row) => {
    if (row.kind === "issue") return { ...issue(row.r), facts: [] };
    if (row.kind === "more") {
      return { key: keyOf(row), href: row.href, title: <span className="text-muted">{t("dash.more", { n: row.n })}</span>, facts: [], state: null, waitingOn: null, owner: null, age: null };
    }
    if (row.kind === "decision") {
      const d = row.d;
      const title = d.title || decisionLineOf(d).line;
      return {
        key: keyOf(row),
        href: decisionPlace(slug, d),
        title: <span title={d.entity === "question" ? title : `${d.key} · ${title}`}>{title}</span>,
        facts: [],
        state: <StatusChip tone="you" label={t(`dash.decision.${d.group}`)} />,
        waitingOn: null,
        owner: null,
        age: age(d.touchedAt),
      };
    }
    const r = row.r;
    return {
      key: keyOf(row),
      href: releaseHref(slug, r.version),
      title: <span title={r.version}>{r.name ?? r.version}</span>,
      facts: [],
      state: <StatusBadge family="releaseState" value={r.state} />,
      waitingOn: null,
      owner: null,
      age: age(r.releasedAt),
    };
  };
}

interface DashRead {
  /** The decisions the read lists, and how many it counts in all: the one Needs you number (REQ-48 BC-11). */
  decisions: { listed: NeedsYouDecision[]; total: number };
  issues: IssueStandingRow[];
  shipped: ReleaseSummary[];
}

/** A group's first rows, then one row to `href` for the rest; its header counts `total`, never the rows named. */
function capped(id: string, rows: DashRow[], total: number, href: string): { rows: DashRow[]; total: number } {
  const named = rows.slice(0, id === "needs" ? NEEDS_YOU_PERSON_CAP : DASHBOARD_ROWS);
  const n = total - named.length;
  return { rows: n > 0 ? [...named, { kind: "more", group: id, n, href }] : named, total };
}

/** The groups a Dashboard draws that ask for someone: decisions waiting on the reader, and stuck work. */
const ATTENTION_GROUPS = new Set(["needs", "stuck"]);

/**
 * Whether a project needs attention, read as its Dashboard reads it (ISS-1072): its Needs you or its
 * Stuck group holds anything. The Projects page reads its Attention through this one reading, never
 * a rule of its own over parked statuses, so the two never disagree.
 */
export function needsAttention(t: Copy, read: Pick<DashRead, "decisions" | "issues">): boolean {
  return groupsOf(t, "", { ...read, shipped: [] }).some((g) => ATTENTION_GROUPS.has(g.id) && g.rows.length > 0);
}

/**
 * Each project's attention by {@link needsAttention}, from the reads its Dashboard makes and shares:
 * the Issues list's open standing and the decisions waiting on the reader. A project not yet read is
 * absent, never read as calm or as needing attention.
 */
export function useProjectsAttention(projectIds: readonly string[]): ReadonlyMap<string, boolean> {
  const t = useCopy();
  const standing = useQueries({ queries: projectIds.map((id) => issueStandingQuery(id, "open")) });
  const decisions = useQueries({ queries: projectIds.map((id) => needsYouDecisionsQuery(id)) });
  const read = new Map<string, boolean>();
  projectIds.forEach((id, i) => {
    const issues = standing[i]?.data;
    const owed = decisions[i]?.data;
    if (!issues || !owed) return;
    read.set(id, needsAttention(t, { decisions: { listed: owed.decisions, total: owed.total }, issues: issues.issues }));
  });
  return read;
}

function groupsOf(t: Copy, slug: string, read: DashRead): ListGroup<DashRow>[] {
  const issues = (id: "moving" | "stuck") => {
    const rows = read.issues.filter((r) => r.standing.attentionGroup === id).map((r): DashRow => ({ kind: "issue", r }));
    return capped(id, rows, rows.length, issuesHref(slug));
  };
  const needs = capped("needs", read.decisions.listed.map((d): DashRow => ({ kind: "decision", d })), read.decisions.total, approvalsHref(slug));
  return [
    { id: "needs", label: t("dash.group.needs"), tone: "you", ...needs },
    { id: "moving", label: t("dash.group.moving"), tone: "run", ...issues("moving") },
    { id: "shipped", label: t("dash.group.shipped"), tone: "done", rows: read.shipped.map((r) => ({ kind: "release", r })) },
    { id: "stuck", label: t("dash.group.stuck"), tone: "blocked", ...issues("stuck") },
  ];
}

export function ProjectDashboard({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const router = useRouter();
  const fold = useGroupFold("web-v2:dashboard-fold");
  const needsQ = useNeedsYouDecisions(projectId);
  const issuesQ = useIssueStanding(projectId, "open");
  // the newest releases that shipped, newest first, as core orders them: never the whole list (ISS-1070)
  const releasesQ = useShippedReleases(projectId, DASHBOARD_ROWS);
  const needs = needsQ.data;
  const decisions = { listed: needs?.decisions ?? [], total: needs?.total ?? 0 };
  const issues = issuesQ.data?.issues ?? [];
  const shipped = releasesQ.data?.releases ?? [];
  const view = useRowView(slug);
  const groups = groupsOf(t, slug, { decisions, issues, shipped });
  const hrefs = new Map(groups.flatMap((g) => g.rows.map((r) => [keyOf(r), view(r).href] as const)));
  // The list draws once the issues and the releases answer; Needs you, core's slowest read (5 s on
  // forge-dev), joins it when it answers, so the page never waits on it (ISS-1070). Never "All quiet"
  // over a list still being read: that would say nothing waits, which nobody has read yet.
  const needsReading = needsQ.isLoading;
  const othersEmpty = groups.every((g) => g.id === "needs" || g.rows.length === 0);
  const reading = issuesQ.isLoading || releasesQ.isLoading || (needsReading && othersEmpty);
  return (
    <div className="flex flex-col gap-4" data-testid={reading ? "dashboard-reading" : "dashboard"}>
      {!reading && needsReading ? (
        <div className="grid place-items-center" data-testid="dashboard-needs-reading">
          <ProjectLoader label={t("dash.group.needs")} size={40} />
        </div>
      ) : null}
      {reading ? (
        <div className="grid place-items-center py-16">
          <ProjectLoader label={t("dash.loading")} />
        </div>
      ) : (
        <GroupedList
          ariaLabel={t("dash.title")}
          groups={groups}
          fold={fold}
          row={view}
          selected={null}
          onPeek={(key) => {
            const href = hrefs.get(key);
            if (href) router.push(href);
          }}
          keyColumn={false}
          empty={t("dash.empty")}
        />
      )}
      {/* mounted from the first paint, so its read leaves with the rest rather than after them */}
      <AuditLine projectId={projectId} />
    </div>
  );
}
