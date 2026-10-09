"use client";

// The Requirements list (`forge-prototype.html` #/requirements): the grouping in the top header, a
// search, the BA assistant's open suggestions, then the shared GroupedList by whose turn it is, by
// state, or by roadmap lane (REQ-33 BC-3: Now, Next and Later by `ROADMAP_HORIZON_OF`, the rule the
// status report's roadmap reads). Each row reads core's standing (`requirements/standing.ts`);
// nothing here derives whose turn it is.
// The URL carries the view (`?group=…&q=…&peek=REQ-n`), so back from the full page restores it.

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { AcceptStep, AGENT_TINT, Button, EmptyState, Field, Input, ListSearch, PageTitle, rememberListOrigin, StatusBadge, Textarea, TopBarActions, usePeek, usePeekKeys, useUrlParams, useViewMode, ViewModeSwitcher, } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage, } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { RejectStep } from "@/features/suggestions/components/reject-step";
import { acceptConsequence, PendingBadge, summaryOf } from "@/features/suggestions/components/suggestion-list";
import { requirementAffected, useProjectWaitingSuggestions, useSuggestionDecision } from "@/features/suggestions/hooks";
import type { SuggestionView as Suggestion } from "@/features/suggestions/types";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useCreateRequirement, useRequirementAreas, useRequirements } from "../hooks";
import { AreasEditor, PlacementBanner } from "./requirement-placement";
import { listGroupsOf, RequirementsList, useAttentionLabel } from "./requirements-list";
import { RequirementsMap } from "./requirements-map";
import { useChatDock } from "@/features/chat-dock/dock";
import { useWorkflows } from "@/features/workflows/hooks";
import { REQUIREMENTS_LIST, requirementHref } from "@/lib/routes/requirements";
import type { RequirementSummary } from "../types";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { ListFilterBar, useListNarrowing } from "@/features/chat-dock/list-filter-bar";
import { RequirementPeek } from "./requirement-peek";

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

/** The views in the interface language; the URL carries only their values. */
const modesIn = (t: Copy) => [
  { value: "attention" as const, label: t("requirements.mode.list"), title: t("requirements.mode.listTitle") },
  { value: "area" as const, label: t("requirements.mode.area"), title: t("requirements.mode.areaTitle") },
  { value: "map" as const, label: t("requirements.mode.map"), title: t("requirements.mode.mapTitle") },
];

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
  const [shown, setShown] = useState(false);
  if (open.length === 0) return null;
  if (!shown) {
    return (
      <button type="button" onClick={() => setShown(true)} className="flex w-full items-center gap-2.5 border-b border-line-subtle px-5 py-2.5 text-left text-13 text-muted max-md:px-3" data-testid="assistant-strip-collapsed">
        <span className="size-1.5 rounded-full bg-accent" />
        {t("requirements.assistant.count", { n: open.length })}
        <span className="font-medium text-accent-text">{t("requirements.assistant.show")}</span>
      </button>
    );
  }
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
  const [step, setStep] = useState<"accept" | "reject" | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 py-[3px]" data-testid="assistant-strip-row">
      <span className="font-mono text-11-5 font-semibold text-link">{r.key}</span>
      <StatusBadge family="requirement" value={r.standing.state} />
      <span className="min-w-0 truncate">{summaryOf(s, lang)}</span>
      <span className="flex-1" />
      <PendingBadge />
      {/* while a step is open its openers are off: a second press would close it and drop the typed reason */}
      <Button type="button" size="sm" disabled={decide.isPending || step !== null} onClick={() => setStep("accept")} aria-expanded={step === "accept"}>
        {t("requirements.assistant.accept")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={decide.isPending || step !== null} onClick={() => setStep("reject")} aria-expanded={step === "reject"}>
        {t("requirements.act.reject")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onPeek(r.key)}>
        {t("requirements.assistant.review")}
      </Button>
      {step === "accept" ? (
        <div className="basis-full">
          <AcceptStep
            confirmLabel={t("requirements.assistant.accept")}
            consequence={acceptConsequence(s, lang)}
            loading={decide.isPending}
            onCancel={() => setStep(null)}
            onConfirm={(why) => decide.mutate({ kind: "accept", id: s.id, reason: why }, { onSuccess: () => setStep(null) })}
          />
        </div>
      ) : null}
      {step === "reject" ? (
        <div className="basis-full">
          <RejectStep
            loading={decide.isPending}
            onCancel={() => setStep(null)}
            onConfirm={(why) => decide.mutate({ kind: "reject", id: s.id, reason: why }, { onSuccess: () => setStep(null) })}
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
  const label = useAttentionLabel();
  const modes = useMemo(() => modesIn(t), [t]);
  const q = useRequirements(projectId);
  useProjectWaitingSuggestions(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [mode, setMode] = useViewMode(modes);
  const text = params.get("q") ?? "";
  const areaFilter = params.get("area") ?? "";
  const [creating, setCreating] = useState(false);
  const dock = useChatDock();
  const approvedDesigns = (useWorkflows(projectId).data?.workflows ?? []).filter((w) => w.design.status === "approved").length;
  const areas = useRequirementAreas(projectId).data ?? [];
  const clock = useEtaClock();

  const all = q.data?.requirements ?? [];
  // the search box reads q; whom a row waits on and its state are the list filter the chat sets too (REQ-41 BC-5)
  const filter = useListNarrowing("requirements");
  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return all.filter(
      (r) =>
        (!needle || `${r.key} ${r.title} ${r.shortName ?? ""}`.toLowerCase().includes(needle)) &&
        (!areaFilter || (areaFilter === "none" ? !r.area : r.area?.id === areaFilter)) &&
        matchesListFilter(filter, { waiting: waitingFilterOf(r.standing), text: "", state: r.standing.state }),
    );
  }, [all, text, areaFilter, filter]);
  const groups = useMemo(() => listGroupsOf(rows, mode === "area" ? "area" : "attention", areas, label, t("requirements.noArea")), [rows, mode, areas, label, t]);
  const visible = useMemo(() => (mode === "map" ? rows : groups.filter((g) => g.id !== "done").flatMap((g) => g.rows)).map((r) => r.key), [rows, groups, mode]);
  const allKeys = useMemo(() => all.map((r) => r.key), [all]);
  const peek = usePeek(visible, allKeys);

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
                <ListSearch noun={t("requirements.searchNoun")} value={text} onChange={(v) => setParams({ q: v || null })} />
                <select aria-label={t("requirements.filter.area")} value={areaFilter} onChange={(e) => setParams({ area: e.target.value || null })} className="h-8 rounded-md border border-line bg-surface px-2 text-13 text-muted">
                  <option value="">{t("requirements.filter.anyArea")}</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  <option value="none">{t("requirements.noArea")}</option>
                </select>
                <ListFilterBar list="requirements" />
                <AreasEditor projectId={projectId} areas={areas} />
              </div>
              <AssistantStrip projectId={projectId} rows={all} onPeek={(k) => peek.set(k)} />
              <PlacementBanner projectId={projectId} rows={all} hasAreas={areas.length > 0} />
              {all.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title={t("requirements.emptyTitle")}
                    message={t("requirements.emptyMessage")}
                    action={
                      dock && approvedDesigns > 0
                        ? { label: t("requirements.draftFromDesigns", { n: approvedDesigns }), onClick: () => dock.show({ kind: "draft", projectId, draft: t("requirements.draftFromDesignsAsk") }) }
                        : undefined
                    }
                  />
                </div>
              ) : mode === "map" ? (
                <RequirementsMap rows={rows} areas={areas} slug={slug} onPeek={(k) => peek.set(k === peek.open ? null : k)} />
              ) : (
                <RequirementsList groups={groups} slug={slug} now={clock.now} selected={peek.open} onPeek={(k) => peek.set(k === peek.open ? null : k)} />
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
