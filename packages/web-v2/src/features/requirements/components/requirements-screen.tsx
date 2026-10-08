"use client";

// The Requirements list (`forge-prototype.html` #/requirements): the grouping in the top header, a
// search, the BA assistant's open suggestions, then the shared GroupedList by whose turn it is, by
// state, or by roadmap lane (REQ-33 BC-3: Now, Next and Later by `ROADMAP_HORIZON_OF`, the rule the
// status report's roadmap reads). Each row reads core's standing (`requirements/standing.ts`);
// nothing here derives whose turn it is.
// The URL carries the view (`?group=…&q=…&peek=REQ-n`), so back from the full page restores it.

import type { IssueProgress } from "@forge/contracts/forecast";
import { ROADMAP_HORIZON_OF, ROADMAP_HORIZONS } from "@forge/contracts/project-status";
import { REQUIREMENT_ATTENTION_GROUPS, REQUIREMENT_ATTENTION_LABELS, REQUIREMENT_STATE_TONES, REQUIREMENT_STATES } from "@forge/contracts/requirements";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { AcceptStep, ActorChip, AGENT_TINT, Button, EmptyState, Field, GroupedList, Input, ListSearch, type ListGroup, type ListRowView, PageTitle, rememberListOrigin, sortGroupsBy, StatusBadge, Textarea, TopBarActions, useGroupFold, usePeek, usePeekKeys, useUrlParams, useViewMode, ViewModeSwitcher, visibleRows, WaitingOn } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { acceptConsequence, PendingBadge, summaryOf } from "@/features/suggestions/components/suggestion-list";
import { requirementAffected, useProjectWaitingSuggestions, useSuggestionDecision } from "@/features/suggestions/hooks";
import type { SuggestionView as Suggestion } from "@/features/suggestions/types";
import { EtaCell } from "@/features/forecast/components/eta-cell";
import { type Eta, type EtaClock, etaOfScope, etaSortValue } from "@/features/forecast/eta";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { progressText } from "@/features/forecast/progress";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useEtaSort, useRequirementForecasts } from "@/features/forecast/hooks";
import { useCreateRequirement, useRequirements } from "../hooks";
import { REQUIREMENTS_LIST, requirementHref } from "@/lib/routes/requirements";
import type { RequirementSummary } from "../types";
import { RequirementPeek } from "./requirement-peek";
import { revisionText } from "./standing-bits";

export function CreateRequirementForm({ projectId, onDone }: { projectId: string; onDone: (key: string) => void }) {
  const t = useCopy();
  const create = useCreateRequirement(projectId);
  const submitting = useSubmitGuard();
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [criteria, setCriteria] = useState("");
  const lines = criteria
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <form
      className="grid max-w-2xl gap-3 border-b border-line-subtle bg-surface px-5 py-4"
      data-testid="requirement-create"
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitting.claim()) return;
        create.mutate(
          { title: title.trim(), reason: reason.trim(), criteria: lines.map((body) => ({ body })) },
          { onSuccess: (d) => onDone(d.key), onSettled: submitting.release },
        );
      }}
    >
      <Field label={t("requirements.form.title")} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label={t("requirements.form.reason")} hint={t("requirements.form.reasonHint")}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label={t("requirements.form.criteria")} hint={t("requirements.form.criteriaHint")}>
        <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={4} />
      </Field>
      <RefusalLine error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={create.isPending} disabled={!title.trim()}>
          {t("requirements.form.create")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone("")} disabled={create.isPending}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** The grouping modes in the interface language; the URL carries only their values. */
const modesIn = (t: Copy) => [
  { value: "attention" as const, label: t("requirements.mode.attention"), title: t("requirements.mode.attentionTitle") },
  { value: "status" as const, label: t("requirements.mode.status"), title: t("requirements.mode.statusTitle") },
  { value: "roadmap" as const, label: t("requirements.mode.roadmap"), title: t("requirements.mode.roadmapTitle") },
];
type GroupMode = ReturnType<typeof modesIn>[number]["value"];

type Label = ReturnType<typeof useLabel>;

export function groupsOf(rows: RequirementSummary[], mode: GroupMode, label: Label, t: Copy): ListGroup<RequirementSummary>[] {
  if (mode === "roadmap") {
    const lane = (r: RequirementSummary) => ROADMAP_HORIZON_OF[r.standing.state];
    return [
      ...ROADMAP_HORIZONS.map((h) => ({ id: `roadmap:${h}`, label: t(`status.horizon.${h}`), hint: t(`roadmap.rule.${h}`), rows: rows.filter((r) => lane(r) === h) })),
      { id: "roadmap:off", label: t("requirements.roadmap.off"), hint: t("requirements.roadmap.offHint"), collapsed: true, rows: rows.filter((r) => lane(r) === null) },
    ];
  }
  if (mode === "status") {
    return REQUIREMENT_STATES.map((s) => ({
      id: `status:${s}`,
      label: label("requirementState", s),
      tone: REQUIREMENT_STATE_TONES[s],
      collapsed: s === "accepted" || s === "dropped",
      rows: rows.filter((r) => r.standing.state === s),
    }));
  }
  return REQUIREMENT_ATTENTION_GROUPS.map((g) => {
    const own = REQUIREMENT_ATTENTION_LABELS[g];
    return {
      id: g,
      ...own,
      label: label("requirementAttention", g),
      hint: own.hint ? label("requirementAttentionHint", g) : own.hint,
      rows: rows.filter((r) => r.standing.attentionGroup === g),
    };
  });
}

/** The secondary line: revision, coverage, and its issues' progress, core's one count of it (JU-2). */
function factsLine(t: Copy, r: RequirementSummary, progress: IssueProgress | undefined): string[] {
  const f = r.standing.facts;
  const lane = ROADMAP_HORIZON_OF[r.standing.state];
  const parts = [revisionText(t, r.currentRevision, r.standing)];
  if (lane) parts.push(t("requirements.row.lane", { lane: t(`status.horizon.${lane}`) }));
  if (f.issuesTotal === 0 && f.judged === 0) parts.push(f.criteria ? t("requirements.row.criteria", { n: f.criteria }) : t("requirements.row.noCriteria"));
  else parts.push(t("requirements.row.passing", { a: f.passing, b: f.criteria }));
  if (f.issuesTotal === 0) parts.push(t("requirements.row.notBrokenDown"));
  else if (progress) parts.push(progressText(progress, t));
  return parts;
}

type TimeFormat = ReturnType<typeof useTimeFormat>;

const rowOf =
  (slug: string, etaOf: (key: string) => Eta | null, progressOf: (key: string) => IssueProgress | undefined, clock: EtaClock, t: Copy, time: TimeFormat) =>
  (r: RequirementSummary): ListRowView => ({
    key: r.key,
    href: requirementHref(slug, r.key),
    title: r.title,
    facts: factsLine(t, r, progressOf(r.key)),
    eta: <EtaCell eta={etaOf(r.key)} clock={clock} />,
    state: <StatusBadge family="requirement" value={r.standing.state} />,
    waitingOn: <WaitingOn w={r.standing.waitingOn} />,
    owner: r.standing.owner ? (
      <ActorChip name={r.standing.owner.name ?? t("requirements.unknown")} kind={r.standing.owner.kind} size={20} />
    ) : (
      <span className="text-subtle">{t("requirements.noOwner")}</span>
    ),
    age: { text: time.relative(r.standing.touchedAt, clock.now), title: t("requirements.row.lastTouched", { at: time.dateTime(r.standing.touchedAt) }) },
    dim: r.standing.attentionGroup === "done",
  });

function AssistantStrip({
  projectId,
  rows,
  onPeek,
}: {
  projectId: string;
  rows: RequirementSummary[];
  onPeek: (key: string) => void;
}) {
  const t = useCopy();
  const q = useProjectWaitingSuggestions(projectId);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const open = (q.data?.suggestions ?? []).filter((s) => s.target.type === "requirement" && byId.has(s.target.id));
  if (open.length === 0) return null;
  return (
    <section
      className="border-l-[3px] py-2 pl-[17px] pr-5 text-12-5"
      style={{ background: AGENT_TINT.bg, borderColor: AGENT_TINT.dot }}
      aria-label={t("requirements.assistant.label")}
      data-testid="assistant-strip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold" style={{ color: AGENT_TINT.fg }}>
          {t("requirements.assistant.name")}
        </span>
        <span className="text-subtle">{t("requirements.assistant.count", { n: open.length })}</span>
      </div>
      {open.map((s) => {
        const r = byId.get(s.target.id) as RequirementSummary;
        return <StripRow key={s.id} s={s} r={r} projectId={projectId} onPeek={onPeek} />;
      })}
    </section>
  );
}

function StripRow({ s, r, projectId, onPeek }: { s: Suggestion; r: RequirementSummary; projectId: string; onPeek: (k: string) => void }) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  const decide = useSuggestionDecision(projectId, requirementAffected(projectId, r.key));
  const [accepting, setAccepting] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 py-[3px]" data-testid="assistant-strip-row">
      <span className="font-mono text-11-5 font-semibold text-link">{r.key}</span>
      <StatusBadge family="requirement" value={r.standing.state} />
      <span className="min-w-0 truncate">{summaryOf(s, lang)}</span>
      <span className="flex-1" />
      <PendingBadge />
      <Button type="button" size="sm" disabled={decide.isPending || accepting} onClick={() => setAccepting(true)} aria-expanded={accepting}>
        {t("requirements.assistant.accept")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onPeek(r.key)}>
        {t("requirements.assistant.review")}
      </Button>
      {accepting ? (
        <div className="basis-full">
          <AcceptStep
            confirmLabel={t("requirements.assistant.accept")}
            consequence={acceptConsequence(s, lang)}
            loading={decide.isPending}
            onCancel={() => setAccepting(false)}
            onConfirm={(why) => decide.mutate({ kind: "accept", id: s.id, reason: why }, { onSuccess: () => setAccepting(false) })}
          />
        </div>
      ) : null}
      {decide.error ? (
        <span className="basis-full">
          <RefusalLine error={decide.error} />
        </span>
      ) : null}
    </div>
  );
}

export function RequirementsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const modes = useMemo(() => modesIn(t), [t]);
  const q = useRequirements(projectId);
  useProjectWaitingSuggestions(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [mode, setMode] = useViewMode(modes);
  const text = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const fold = useGroupFold("web-v2:requirements-fold");

  const all = q.data?.requirements ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.key} ${r.title}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const forecastQ = useRequirementForecasts(projectId);
  const forecasts = useMemo(() => new Map((forecastQ.data?.requirements ?? []).map((s) => [s.key, s])), [forecastQ.data]);
  const clock = useEtaClock();
  const [etaSorted, toggleEtaSort] = useEtaSort();
  const etaOf = useCallback((k: string) => etaOfScope(forecasts.get(k), clock), [forecasts, clock]);
  const groups = useMemo(() => {
    const plain = groupsOf(rows, mode, label, t);
    // a lane reads soonest forecast first, as the status report's roadmap does
    return etaSorted || mode === "roadmap" ? sortGroupsBy(plain, (r) => etaSortValue(etaOf(r.key))) : plain;
  }, [rows, mode, etaSorted, etaOf, label, t]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.key), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.key), [all]);
  const peek = usePeek(visible, allKeys);
  const progressOf = useCallback((k: string) => forecasts.get(k)?.progress, [forecasts]);
  const row = useMemo(() => rowOf(slug, etaOf, progressOf, clock, t, time), [slug, etaOf, progressOf, clock, t, time]);

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(REQUIREMENTS_LIST);
      router.push(requirementHref(slug, key));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = (
    <>
      <PageTitle after={<ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="header" />}>{t("requirements.title")}</PageTitle>
      <TopBarActions>
        <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
          {t("requirements.new")}
        </Button>
      </TopBarActions>
    </>
  );
  return (
    <QueryBoundary query={q} loadingLabel={t("requirements.loadingList")} title={title} height="60vh" retry="always">
      {() => (
        <div className="grid min-h-full content-start bg-app" data-testid="requirements-screen">
          {title}
          {creating ? (
            <CreateRequirementForm
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
                <ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="toolbar" />
                <ListSearch noun={t("requirements.searchNoun")} value={text} onChange={(q) => setParams({ q: q || null })} />
              </div>
              <AssistantStrip projectId={projectId} rows={all} onPeek={(k) => peek.set(k)} />
              {all.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState title={t("requirements.emptyTitle")} message={t("requirements.emptyMessage")} />
                </div>
              ) : (
                <GroupedList
                  ariaLabel={t("requirements.title")}
                  groups={groups}
                  fold={fold}
                  row={row}
                  eta={{ label: ETA_COPY[clock.lang].header, sortLabel: ETA_COPY[clock.lang].sortBy, sorted: etaSorted, onSort: toggleEtaSort }}
                  selected={peek.open}
                  onPeek={(k) => peek.set(k === peek.open ? null : k)}
                  empty={t("requirements.noMatch")}
                />
              )}
            </div>
            {peek.open ? (
              <RequirementPeek key={peek.open} projectId={projectId} slug={slug} reqKey={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} />
            ) : null}
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
