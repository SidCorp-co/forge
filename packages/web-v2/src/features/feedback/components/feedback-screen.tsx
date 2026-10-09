"use client";

// The Feedback list (`forge-prototype.html` #/feedback): the grouping in the top header, a search,
// the triage funnel, then the shared GroupedList — the same columns as Requirements and Issues — by
// whose turn it is or by what each item is about. Whose turn comes from core's read model
// (`feedback/read.ts`); the URL carries the view (`?group=…&q=…&peek=FB-n`).

import { Written } from "@/lib/i18n/written";
import { FEEDBACK_ATTENTION_GROUPS, FEEDBACK_ATTENTION_LABELS, FEEDBACK_PHASE_TONES, type FeedbackAttentionGroup } from "@forge/contracts/feedback";
import type { StandingGroupLabels } from "@forge/contracts/standing";
import { needsViewer } from "@forge/contracts/standing";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { ListFilterBar, useListNarrowing } from "@/features/chat-dock/list-filter-bar";
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
  sortGroupsBy,
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
import { useCopy, useInterfaceLanguage, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { EtaCell } from "@/features/forecast/components/eta-cell";
import { type Eta, type EtaClock, etaOfFeedback, etaSortValue } from "@/features/forecast/eta";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useEtaSort, useFeedbackForecasts } from "@/features/forecast/hooks";
import { useFeedbackList } from "../hooks";
import { FEEDBACK_LIST, feedbackHref } from "@/lib/routes/feedback";
import type { FeedbackListResponse, FeedbackSummary } from "../types";
import { FeedbackForm } from "./feedback-form";
import { FeedbackPeek } from "./feedback-peek";

const FUNNEL = ["new", "triaged", "planned", "resolved", "verified"] as const;

function Funnel({ rows, untold }: { rows: FeedbackSummary[]; untold: FeedbackListResponse["untold"] | undefined }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  const n = (p: string) => rows.filter((r) => r.phase === p).length;
  const total = Math.max(1, ...FUNNEL.map((p) => n(p)));
  return (
    <div className="grid gap-2 border-b border-line-subtle bg-app px-5 py-3 max-md:px-3" data-testid="feedback-funnel">
      <p className="text-12 text-muted">
        <span className="font-semibold text-fg">{t("feedback.funnel.title")}</span> {t("feedback.funnel.hint")}
      </p>
      <div className="grid grid-cols-5 gap-3">
        {FUNNEL.map((p) => {
          const r = statusReading("feedbackPhase", p, language);
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
        {t("feedback.funnel.off", {
          declined: statusReading("feedbackPhase", "declined", language).label,
          nDeclined: n("declined"),
          reopened: statusReading("feedbackPhase", "reopened", language).label,
          nReopened: n("reopened"),
        })}
      </p>
      {untold && (untold.owed > 0 || untold.beforeNotices > 0) ? (
        <p className="text-12 text-muted" data-testid="feedback-untold">
          {[
            untold.owed > 0 ? t("feedback.funnel.untoldOwed", { n: untold.owed }) : "",
            untold.beforeNotices > 0
              ? t("feedback.funnel.untoldBefore", { n: untold.beforeNotices, date: untold.noticesBegan ? time.date(untold.noticesBegan) : "" })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

const aboutLine = (r: FeedbackSummary, t: Copy, language: string) =>
  r.target.type === "screen"
    ? t("feedback.target.screen", { label: enumLabel("feedbackTarget", "screen", language), key: r.target.key })
    : `${enumLabel("feedbackTarget", r.target.type, language)} ${r.target.key}`;

type Grouping = "attention" | "subject";

/** The two groupings, named in the interface language. */
const groupModes = (t: Copy) => [
  { value: "attention" as const, label: t("feedback.group.attention"), title: t("feedback.group.attentionTitle") },
  { value: "subject" as const, label: t("feedback.group.subject"), title: t("feedback.group.subjectTitle") },
];

/** Core's attention groups with their label and hint in the interface language. */
const attentionLabels = (label: ReturnType<typeof useLabel>): StandingGroupLabels<FeedbackAttentionGroup> =>
  Object.fromEntries(
    FEEDBACK_ATTENTION_GROUPS.map((g) => [
      g,
      { ...FEEDBACK_ATTENTION_LABELS[g], label: label("feedbackAttention", g), hint: FEEDBACK_ATTENTION_LABELS[g].hint ? label("feedbackAttentionHint", g) : FEEDBACK_ATTENTION_LABELS[g].hint },
    ]),
  ) as StandingGroupLabels<FeedbackAttentionGroup>;

function groupsOf(rows: FeedbackSummary[], by: Grouping, label: ReturnType<typeof useLabel>, t: Copy, language: string): ListGroup<FeedbackSummary>[] {
  if (by === "attention") {
    return standingGroups(rows, FEEDBACK_ATTENTION_GROUPS, attentionLabels(label));
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
      label: aboutLine(list[0] as FeedbackSummary, t, language),
      tone: you ? ("you" as const) : null,
      summary: you ? [{ label: label("feedbackAttention", "needs_you"), count: you, tone: "you" as const }] : undefined,
      rows: list,
    };
  });
}

const rowOf =
  (slug: string, etaOf: (key: string) => Eta | null, clock: EtaClock, t: Copy, time: ReturnType<typeof useTimeFormat>) =>
  (r: FeedbackSummary): ListRowView => {
    const language = clock.lang;
    const reporter = r.reporter.name ?? t("feedback.unknownReporter");
    return {
      key: r.key,
      href: feedbackHref(slug, r.key),
      title: <Written text={r.title} lang={r.writtenLang} />,
      facts: [
        ...(r.snoozed ? [t("feedback.row.snoozedUntil", { date: time.dateTime(r.snoozed.until) })] : []),
        enumLabel("feedbackKind", r.kind, language),
        t("feedback.row.about", { about: aboutLine(r, t, language) }),
        reporter,
        t("feedback.row.severity", { severity: statusReading("severity", r.severity, language).label }),
      ],
      eta: <EtaCell eta={etaOf(r.key)} clock={clock} />,
      state: <StatusBadge family="feedbackPhase" value={r.phase} />,
      waitingOn: <WaitingOn w={r.waitingOn} />,
      owner: <ActorChip name={reporter} kind={r.reporter.agency} size={20} />,
      age: { text: time.age(r.updatedAt), title: t("feedback.row.ageTitle", { sent: time.dateTime(r.createdAt), changed: time.dateTime(r.updatedAt) }) },
      dim: r.attentionGroup === "done",
    };
  };

export function FeedbackScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  const modes = useMemo(() => groupModes(t), [t]);
  const q = useFeedbackList(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [grouping, setGrouping] = useViewMode(modes);
  const text = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const fold = useGroupFold("web-v2:feedback-fold");

  const all = q.data?.feedback ?? [];
  // the search box reads q; the rest is the list filter the chat sets too (REQ-41 BC-5)
  const filter = useListNarrowing("feedback");
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return all.filter(
      (r) =>
        (!t || `${r.key} ${r.title} ${r.reporter.name ?? ""}`.toLowerCase().includes(t)) &&
        matchesListFilter(filter, { waiting: waitingFilterOf(r), text: "", phase: r.phase, kind: r.kind, severity: r.severity, createdAt: r.createdAt }),
    );
  }, [all, text, filter]);
  const forecastQ = useFeedbackForecasts(projectId);
  const forecasts = useMemo(() => new Map((forecastQ.data?.items ?? []).map((i) => [i.key, i])), [forecastQ.data]);
  const clock = useEtaClock();
  const [etaSorted, toggleEtaSort] = useEtaSort();
  const etaOf = useCallback((k: string) => etaOfFeedback(forecasts.get(k), clock), [forecasts, clock]);
  const groups = useMemo(() => {
    const plain = groupsOf(rows, grouping, label, t, language);
    return etaSorted ? sortGroupsBy(plain, (r) => etaSortValue(etaOf(r.key))) : plain;
  }, [rows, grouping, etaSorted, etaOf, label, t, language]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.key), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.key), [all]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => rowOf(slug, etaOf, clock, t, time), [slug, etaOf, clock, t, time]);

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
      <PageTitle after={<ViewModeSwitcher modes={modes} value={grouping} onChange={setGrouping} placement="header" />}>{t("feedback.title")}</PageTitle>
      <TopBarActions>
        <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
          {t("feedback.title")}
        </Button>
      </TopBarActions>
    </>
  );
  return (
    <QueryBoundary query={q} loadingLabel={t("feedback.loading")} title={title} height="60vh" retry="always">
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
                <ViewModeSwitcher modes={modes} value={grouping} onChange={setGrouping} placement="toolbar" />
                <ListSearch noun={t("feedback.noun")} value={text} onChange={(q) => setParams({ q: q || null })} />
                <ListFilterBar list="feedback" />
              </div>
              {all.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState title={t("feedback.empty.title")} message={t("feedback.empty.message")} />
                </div>
              ) : (
                <>
                  <Funnel rows={all} untold={q.data?.untold} />
                  <GroupedList
                    ariaLabel={t("feedback.title")}
                    groups={groups}
                    fold={fold}
                    row={row}
                    eta={{ label: ETA_COPY[clock.lang].header, sortLabel: ETA_COPY[clock.lang].sortBy, sorted: etaSorted, onSort: toggleEtaSort }}
                    selected={peek.open}
                    onPeek={(k) => peek.set(k === peek.open ? null : k)}
                    empty={t("feedback.noMatch")}
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
