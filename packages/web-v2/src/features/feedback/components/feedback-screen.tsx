"use client";

// The Feedback list (`forge-prototype.html` #/feedback): the grouping in the top header, a search,
// the triage funnel, then the shared GroupedList — the same columns as Requirements and Issues — by
// whose turn it is or by what each item is about. Whose turn comes from core's read model
// (`feedback/read.ts`); the URL carries the view (`?group=…&q=…&peek=FB-n`).

import { FEEDBACK_ATTENTION_GROUPS, FEEDBACK_ATTENTION_LABELS, FEEDBACK_PHASE_TONES } from "@forge/contracts/feedback";
import { needsViewer } from "@forge/contracts/standing";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  ActorChip,
  Button,
  EmptyState,
  enumLabel,
  GroupedList,
  ListSearch,
  LEGEND,
  type ListGroup,
  type ListRowView,
  PageTitle,
  rememberListOrigin,
  StatusBadge,
  standingGroups,
  statusReading,
  TopBarActions,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  useViewMode,
  ViewModeSwitcher,
  visibleRows,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { cn } from "@/lib/utils/cn";
import { formatAge, formatStamp } from "@/lib/utils/format";
import type { FeedbackForecast } from "@forge/contracts/forecast";
import { useFeedbackForecasts } from "@/features/forecast/hooks";
import { feedbackForecastText } from "@/features/forecast/text";
import { useFeedbackList } from "../hooks";
import { FEEDBACK_LIST, feedbackHref } from "@/lib/routes/feedback";
import type { FeedbackSummary } from "../types";
import { FeedbackForm } from "./feedback-form";
import { FeedbackPeek } from "./feedback-peek";

const FUNNEL = ["new", "triaged", "planned", "resolved", "verified"] as const;

function Funnel({ rows }: { rows: FeedbackSummary[] }) {
  const n = (p: string) => rows.filter((r) => r.phase === p).length;
  const total = Math.max(1, ...FUNNEL.map((p) => n(p)));
  return (
    <div className="grid gap-2 border-b border-line-subtle bg-app px-5 py-3 max-md:px-3" data-testid="feedback-funnel">
      <p className="text-12 text-muted">
        <span className="font-semibold text-fg">Triage funnel</span> Every item, counted once
      </p>
      <div className="grid grid-cols-5 gap-3">
        {FUNNEL.map((p) => {
          const r = statusReading("feedbackPhase", p);
          return (
            <div key={p} className="grid gap-1">
              <span
                className="h-2 rounded-xs"
                style={{ background: LEGEND[FEEDBACK_PHASE_TONES[p]].dot, opacity: n(p) ? 1 : 0.35, width: `${Math.max(12, (n(p) / total) * 100)}%` }}
              />
              <span className="text-12 text-muted">{r.label}</span>
              <span className="text-13 font-semibold tabular-nums">{n(p)}</span>
            </div>
          );
        })}
      </div>
      <p className="text-12 text-muted">
        Off the funnel: Declined {n("declined")} · Reopened {n("reopened")}
      </p>
    </div>
  );
}

const aboutLine = (r: FeedbackSummary) =>
  r.target.type === "screen" ? `Screen “${r.target.key}”` : `${enumLabel("feedbackTarget", r.target.type)} ${r.target.key}`;

const GROUP_MODES = [
  { value: "attention" as const, label: "Attention", title: "Grouped by whose turn it is" },
  { value: "subject" as const, label: "Subject", title: "Grouped by what each item is about" },
];
type Grouping = (typeof GROUP_MODES)[number]["value"];

function groupsOf(rows: FeedbackSummary[], by: Grouping): ListGroup<FeedbackSummary>[] {
  if (by === "attention") {
    return standingGroups(rows, FEEDBACK_ATTENTION_GROUPS, FEEDBACK_ATTENTION_LABELS);
  }
  const byTarget = new Map<string, FeedbackSummary[]>();
  for (const r of rows) {
    const id = `${r.target.type}:${r.target.key}`;
    byTarget.set(id, [...(byTarget.get(id) ?? []), r]);
  }
  return [...byTarget.entries()].map(([id, list]) => {
    const you = list.filter(needsViewer).length;
    return {
      id: `subject:${id}`,
      label: aboutLine(list[0] as FeedbackSummary),
      tone: you ? ("you" as const) : null,
      summary: you ? [{ label: "Needs you", count: you, tone: "you" as const }] : undefined,
      rows: list,
    };
  });
}

const rowOf =
  (slug: string, forecastOf: (key: string) => FeedbackForecast | undefined = () => undefined) =>
  (r: FeedbackSummary): ListRowView => {
    const forecast = forecastOf(r.key);
    const line = forecast ? feedbackForecastText(forecast)?.line : undefined;
    return {
    key: r.key,
    href: feedbackHref(slug, r.key),
    title: r.title,
    facts: [enumLabel("feedbackKind", r.kind), `About ${aboutLine(r)}`, r.reporter.name ?? "Unknown reporter", `Severity ${statusReading("severity", r.severity).label}`, ...(line ? [line] : [])],
    state: <StatusBadge family="feedbackPhase" value={r.phase} />,
    waitingOn: <WaitingOn w={r.waitingOn} />,
    owner: <ActorChip name={r.reporter.name ?? "Unknown reporter"} kind={r.reporter.agency} size={20} />,
    age: { text: formatAge(r.updatedAt), title: `Sent ${formatStamp(r.createdAt)} · last changed ${formatStamp(r.updatedAt)}` },
    dim: r.attentionGroup === "done",
    };
  };

export function FeedbackScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useFeedbackList(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [grouping, setGrouping] = useViewMode(GROUP_MODES);
  const text = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const fold = useGroupFold("web-v2:feedback-fold");

  const all = q.data?.feedback ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.key} ${r.title} ${r.reporter.name ?? ""}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, grouping), [rows, grouping]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.key), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.key), [all]);
  const peek = usePeek(visible, allKeys);
  const forecastQ = useFeedbackForecasts(projectId);
  const forecasts = useMemo(() => new Map((forecastQ.data?.items ?? []).map((i) => [i.key, i])), [forecastQ.data]);
  const row = useMemo(() => rowOf(slug, (k) => forecasts.get(k)), [slug, forecasts]);

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(FEEDBACK_LIST);
      router.push(feedbackHref(slug, key));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = (
    <>
      <PageTitle after={<ViewModeSwitcher modes={GROUP_MODES} value={grouping} onChange={setGrouping} placement="header" />}>Feedback</PageTitle>
      <TopBarActions>
        <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
          Feedback
        </Button>
      </TopBarActions>
    </>
  );
  return (
    <QueryBoundary query={q} loadingLabel="loading feedback…" title={title} height="60vh" retry="always">
      {() => (
        <div className="grid min-h-full content-start bg-app" data-testid="feedback-screen">
          {title}
          {creating ? (
            <FeedbackForm
              projectId={projectId}
              onDone={(key) => {
                setCreating(false);
                if (key) peek.set(key);
              }}
            />
          ) : null}
          <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
                <ViewModeSwitcher modes={GROUP_MODES} value={grouping} onChange={setGrouping} placement="toolbar" />
                <ListSearch noun="feedback" value={text} onChange={(q) => setParams({ q: q || null })} />
              </div>
              {all.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState title="No feedback yet" message="Feedback is what a BA, a tester or a user says about a requirement, an issue, a release, a workflow or a screen." />
                </div>
              ) : (
                <>
                  <Funnel rows={all} />
                  <GroupedList
                    ariaLabel="Feedback"
                    groups={groups}
                    fold={fold}
                    row={row}
                    selected={peek.open}
                    onPeek={(k) => peek.set(k === peek.open ? null : k)}
                    empty="Nothing matches this search."
                  />
                </>
              )}
            </div>
            {peek.open ? (
              <FeedbackPeek key={peek.open} projectId={projectId} slug={slug} fbKey={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} />
            ) : null}
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
