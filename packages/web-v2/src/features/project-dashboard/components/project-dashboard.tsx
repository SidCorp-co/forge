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
import { GroupedList, type ListGroup, type ListRowView, StatusBadge, StatusChip, useGroupFold } from "@/design";
import { AuditLine } from "@/features/activity";
import { issueRowView, useIssueStanding, useRowWords } from "@/features/issues";
import { decisionHref, useNeedsYouDecisions } from "@/features/needs-you";
import { useReleases } from "@/features/releases";
import { approvalsHref, questionDecisionHref } from "@/lib/routes/approvals";
import { releaseHref } from "@/lib/routes/releases";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useRouter } from "@/lib/navigation/router";

/** How many shipped releases the Dashboard names: the newest, the rest on Releases. */
export const DASHBOARD_SHIPPED = 5;

type DashRow = { kind: "decision"; d: NeedsYouDecision } | { kind: "issue"; r: IssueStandingRow } | { kind: "release"; r: ReleaseSummary };

const keyOf = (row: DashRow): string => (row.kind === "decision" ? `d:${row.d.id}` : row.kind === "issue" ? row.r.key : `r:${row.r.version}`);

function decisionPlace(slug: string, d: NeedsYouDecision): string {
  if (d.entity === "question") return questionDecisionHref(slug, d.key);
  return decisionHref(slug, d.opens) ?? approvalsHref(slug);
}

/** The newest releases that shipped, newest first. */
export function shippedOf(releases: readonly ReleaseSummary[] | undefined): ReleaseSummary[] {
  return (releases ?? [])
    .filter((r) => r.releasedAt !== null)
    .sort((a, b) => Date.parse(b.releasedAt ?? "") - Date.parse(a.releasedAt ?? ""))
    .slice(0, DASHBOARD_SHIPPED);
}

function useRowView(slug: string): (row: DashRow) => ListRowView {
  const t = useCopy();
  const time = useTimeFormat();
  const issue = issueRowView(slug, useRowWords());
  const age = (at: string | null) => (at ? { text: time.age(at), title: time.dateTime(at) } : null);
  return (row) => {
    if (row.kind === "issue") return { ...issue(row.r), facts: [] };
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

function groupsOf(t: Copy, read: { decisions: NeedsYouDecision[]; issues: IssueStandingRow[]; shipped: ReleaseSummary[] }): ListGroup<DashRow>[] {
  const issues = (g: IssueStandingRow["standing"]["attentionGroup"]): DashRow[] =>
    read.issues.filter((r) => r.standing.attentionGroup === g).map((r) => ({ kind: "issue", r }));
  return [
    { id: "needs", label: t("dash.group.needs"), tone: "you", rows: read.decisions.map((d) => ({ kind: "decision", d })) },
    { id: "moving", label: t("dash.group.moving"), tone: "run", rows: issues("moving") },
    { id: "shipped", label: t("dash.group.shipped"), tone: "done", rows: read.shipped.map((r) => ({ kind: "release", r })) },
    { id: "stuck", label: t("dash.group.stuck"), tone: "blocked", rows: issues("stuck") },
  ];
}

export function ProjectDashboard({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const router = useRouter();
  const fold = useGroupFold("web-v2:dashboard-fold");
  const decisions = useNeedsYouDecisions(projectId).data?.decisions ?? [];
  const issues = useIssueStanding(projectId, "open").data?.issues ?? [];
  const shipped = shippedOf(useReleases(projectId).data?.releases);
  const view = useRowView(slug);
  const groups = groupsOf(t, { decisions, issues, shipped });
  const hrefs = new Map(groups.flatMap((g) => g.rows.map((r) => [keyOf(r), view(r).href] as const)));
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard">
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
      <AuditLine projectId={projectId} />
    </div>
  );
}
