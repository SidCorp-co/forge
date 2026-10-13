
// The Requirements list (REQ-29): the view in the top header, a search, the BA assistant's open
// suggestions, then one line per requirement by whose turn it is or by business area, or the Map of
// stages and Now, Next and Later (`requirement-roadmap.ts:roadmapHorizonOf`, the rule the status
// report's roadmap reads). Each row reads core's standing (`requirements/standing.ts`); nothing here
// derives whose turn it is.
// The URL carries the view (`?group=…&q=…&peek=REQ-n`), so back from the full page restores it.

import { useMemo, useState } from "react";
import { Button, EmptyState, Field, Input, ListPage, ListSearch, PageTitle, StatusBadge, ToolbarSelect, useListPage, useViewMode, ViewModeSwitcher, focusOnMount } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage, } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { acceptConsequence, PendingBadge, requirementAffected, SuggestionDecider, summaryOf, useProjectWaitingSuggestions } from "@/features/suggestions";
import type { SuggestionView as Suggestion } from "@/features/suggestions";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useCreateRequirement, useRequirementAreas, useRequirements } from "../hooks";
import { AreasEditor, PlacementBanner } from "./requirement-placement";
import { listGroupsOf, RequirementsList, useAttentionLabel } from "./requirements-list";
import { RequirementsMap } from "./requirements-map";
import { useChatDock } from "@/features/chat-dock";
import { useWorkflows } from "@/features/workflows";
import { REQUIREMENTS_LIST, requirementHref } from "@/lib/routes/requirements";
import type { RequirementSummary } from "../types";
import { REQUIREMENT_TITLE_MAX } from "@forge/contracts/title-text";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { ListFilterBar, useListNarrowing } from "@/features/chat-dock";
import { RequirementPeek } from "./requirement-peek";

// a title alone creates it: the assistant drafts the rest and its author is asked why (REQ-34 BC-4, BC-17);
// the title owns the path core refuses a create on, so a refusal is read where it is fixed (BC-18)
const CREATE_FIELDS = { title: ["/title"] } as const;

export function CreateRequirementForm({ projectId, onDone }: { projectId: string; onDone: (key: string) => void }) {
  const t = useCopy();
  const create = useCreateRequirement(projectId);
  const submitting = useSubmitGuard();
  const [title, setTitle] = useState("");
  const refused = placeRefusals(create.error, CREATE_FIELDS);
  return (
    <form
      className="grid max-w-2xl gap-3 border-b border-line-subtle bg-surface px-5 py-4"
      data-testid="requirement-create"
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitting.claim()) return;
        create.mutate(
          { title: title.trim() },
          { onSuccess: (d) => onDone(d.key), onSettled: () => submitting.release() },
        );
      }}
    >
      <Field label={t("requirements.form.title")} error={refused.at("title")} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={REQUIREMENT_TITLE_MAX} ref={focusOnMount} />
      </Field>
      <RefusalLine error={create.error} onField={refused.onField} />
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
  { value: "attention" as const, label: t("requirements.mode.list") },
  { value: "area" as const, label: t("requirements.mode.area") },
  { value: "map" as const, label: t("requirements.mode.map") },
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
        <span className="size-1.5 rounded-pill bg-accent" />
        {t("requirements.assistant.count", { n: open.length })}
        <span className="font-medium text-accent-text">{t("requirements.assistant.show")}</span>
      </button>
    );
  }
  return (
    <section
      className="border-l-3 border-ai-9 bg-ai-bg py-2 pl-4.25 pr-5 text-13"
      aria-label={t("requirements.assistant.label")}
      data-testid="assistant-strip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ai">
          {t("requirements.assistant.name")}
        </span>
        <span className="text-subtle">{t("requirements.assistant.count", { n: open.length })}</span>
      </div>
      {open.map((s) => {
        const r = byId.get(s.target.id) as RequirementSummary;
        return <WaitingSuggestion key={s.id} s={s} r={r} projectId={projectId} onPeek={onPeek} />;
      })}
    </section>
  );
}

function WaitingSuggestion({ s, r, projectId, onPeek }: { s: Suggestion; r: RequirementSummary; projectId: string; onPeek: (k: string) => void }) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  return (
    <div className="flex flex-wrap items-center gap-2 py-0.75" data-testid="assistant-strip-row">
      <span className="font-mono text-12 font-semibold text-link">{r.key}</span>
      <StatusBadge family="requirement" value={r.standing.state} />
      <span className="min-w-0 truncate">{summaryOf(s, lang)}</span>
      <span className="flex-1" />
      <PendingBadge />
      <SuggestionDecider projectId={projectId} s={s} affected={requirementAffected(projectId, r.key)} consequence={acceptConsequence(s, lang)}>
        <Button type="button" size="sm" variant="ghost" onClick={() => onPeek(r.key)}>
          {t("requirements.assistant.review")}
        </Button>
      </SuggestionDecider>
    </div>
  );
}

/** Whether a row sits in the area the toolbar picked: "" any, "none" the rows without one. */
const inArea = (r: RequirementSummary, area: string) => !area || (area === "none" ? !r.area : r.area?.id === area);

export function RequirementsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const label = useAttentionLabel();
  const modes = modesIn(t);
  const q = useRequirements(projectId);
  useProjectWaitingSuggestions(projectId);
  const [mode, setMode] = useViewMode(modes);
  const [creating, setCreating] = useState(false);
  const dock = useChatDock();
  const approvedDesigns = (useWorkflows(projectId).data?.workflows ?? []).filter((w) => w.design.status === "approved").length;
  const areas = useRequirementAreas(projectId).data ?? [];
  const clock = useEtaClock();
  // whom a row waits on and its state are the list filter the chat sets too (REQ-41 BC-5)
  const filter = useListNarrowing("requirements");
  const all = q.data?.requirements ?? [];
  const list = useListPage({
    rows: all,
    keyOf: (r) => r.key,
    searchOf: (r) => `${r.key} ${r.title} ${r.shortName ?? ""}`,
    narrow: (r, params) =>
      inArea(r, params.get("area") ?? "") &&
      matchesListFilter(filter, { waiting: waitingFilterOf(r.standing), text: "", state: r.standing.state }),
    groupsOf: (rows) => listGroupsOf(rows, mode === "area" ? "area" : "attention", areas, label, t("requirements.noArea")),
    foldKey: "web-v2:requirements-fold",
    stepsOf: (groups, rows) => (mode === "map" ? rows : groups.filter((g) => g.id !== "done").flatMap((g) => g.rows)),
    hrefOf: (key) => requirementHref(slug, key),
    origin: REQUIREMENTS_LIST,
  });
  const areaFilter = list.params.get("area") ?? "";
  const { peek } = list;
  const switcher = (placement: "header" | "toolbar") => <ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement={placement} />;

  return (
    <QueryBoundary query={q} loadingLabel={t("requirements.loadingList")} title={<PageTitle>{t("requirements.title")}</PageTitle>} height="60vh" retry="always">
      {() => (
        <ListPage
          testId="requirements-screen"
          title={t("requirements.title")}
          titleAfter={switcher("header")}
          actions={
            <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
              {t("requirements.new")}
            </Button>
          }
          lead={
            creating ? (
              <CreateRequirementForm
                projectId={projectId}
                onDone={(key) => {
                  setCreating(false);
                  if (key) peek.set(key);
                }}
              />
            ) : null
          }
          toolbar={
            <>
              {switcher("toolbar")}
              <ListSearch noun={t("requirements.searchNoun")} {...list.search} />
              <ToolbarSelect
                label={t("requirements.filter.area")}
                value={areaFilter}
                onChange={(v) => list.setParams({ area: v || null })}
                options={[{ value: "", label: t("requirements.filter.anyArea") }, ...areas.map((a) => ({ value: a.id, label: a.name })), { value: "none", label: t("requirements.noArea") }]}
              />
              <ListFilterBar list="requirements" />
              <AreasEditor projectId={projectId} areas={areas} />
            </>
          }
          peek={peek.open ? <RequirementPeek key={peek.open} projectId={projectId} slug={slug} reqKey={peek.open} peek={peek} onOpenFull={() => list.openFull(peek.open as string)} /> : null}
        >
          <AssistantStrip projectId={projectId} rows={all} onPeek={(k) => peek.set(k)} />
          <PlacementBanner projectId={projectId} rows={all} hasAreas={areas.length > 0} />
          {all.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState
                message={t("requirements.empty")}
                action={
                  dock && approvedDesigns > 0
                    ? { label: t("requirements.draftFromDesigns", { n: approvedDesigns }), onClick: () => dock.show({ kind: "draft", projectId, draft: t("requirements.draftFromDesignsAsk") }) }
                    : undefined
                }
              />
            </div>
          ) : mode === "map" ? (
            <RequirementsMap rows={list.rows} areas={areas} slug={slug} onPeek={list.togglePeek} />
          ) : (
            <RequirementsList groups={list.groups} slug={slug} now={clock.now} selected={peek.open} onPeek={list.togglePeek} />
          )}
        </ListPage>
      )}
    </QueryBoundary>
  );
}
