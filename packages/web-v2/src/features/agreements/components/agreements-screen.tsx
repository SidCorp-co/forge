// A project's Agreements page (REQ-90 BC-1, BC-9; ISS-1111; design working-agreements, steps open-page
// and inspect): every working agreement in the lanes Forge default → Project change → Effective, the
// project's changes first, inherited defaults and locked guarantees one click away, searched in `?q=`
// and filtered in `?state=`. A row's name opens the inspector (`?agreement=`), and the context switch
// (`?run=`) shows what one run was given in place of the current rules.

import type { AgreementsView } from "@forge/contracts/agreements";
import { useState } from "react";
import { Button, DetailDrawer, ListSearch, ListToolbar, PageTitle, ToolbarSelect, useGroupFold, useUrlParams } from "@/design";
import { useRunStanding } from "@/features/agents";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useAgreements, useRunAgreements } from "../hooks";
import { currentGroups, inState, receivedOf, searchText, STATE_FILTERS } from "../view";
import { AgreementEdit } from "./agreement-edit";
import { AgreementInspector } from "./agreement-inspector";
import { AgreementLanes } from "./agreement-lanes";
import { RunReceived } from "./run-received";

const RECENT_RUNS = 20;
const CURRENT = "current";

function useRunChoices(projectId: string, run: string | null, t: Copy) {
  const runs = useRunStanding(projectId, "all");
  const items = (runs.data?.items ?? []).filter((r) => r.sessionId).slice(0, RECENT_RUNS);
  const options = [{ value: CURRENT, label: t("agreements.run.current") }, ...items.map((r) => ({ value: r.sessionId as string, label: r.issue?.title ?? r.title }))];
  if (run && !options.some((o) => o.value === run)) options.push({ value: run, label: t("agreements.group.received") });
  return options;
}

/** The run's received agreements, or the current rules' lanes. */
function Rules({ d, projectId, run, selected, onOpen, needle, state }: { d: AgreementsView; projectId: string; run: string | null; selected: string | null; onOpen: (slug: string) => void; needle: string; state: string | null }) {
  const t = useCopy();
  const fold = useGroupFold(run ? "web-v2:agreements-run-fold" : "web-v2:agreements-fold");
  const context = useRunAgreements(projectId, run);
  const rows = d.agreements.filter((a) => (!needle || searchText(a).toLowerCase().includes(needle)) && inState(a, state));
  const narrowed = Boolean(needle || state);
  if (!run) {
    const groups = currentGroups(rows, t).map((g) => (narrowed ? { ...g, collapsed: false } : g));
    if (groups.length === 0) return <p className="px-5 py-8 text-13 text-subtle">{needle ? t("agreements.emptySearch") : t("agreements.empty")}</p>;
    return <AgreementLanes groups={groups} fold={fold} selected={selected} onOpen={onOpen} />;
  }
  return (
    <QueryBoundary query={context} loadingLabel={t("agreements.loading")} height="30vh">
      {(c) => {
        const { received, missing } = receivedOf(rows, c);
        return <RunReceived received={received} missing={missing} fold={fold} selected={selected} onOpen={onOpen} />;
      }}
    </QueryBoundary>
  );
}

export function AgreementsScreen({ projectId, slug, canManage }: { projectId: string; slug: string; canManage: boolean }) {
  const t = useCopy();
  const [params, setParams] = useUrlParams();
  const q = useAgreements(projectId);
  const run = params.get("run");
  const open = params.get("agreement");
  const state = (STATE_FILTERS as readonly string[]).includes(params.get("state") ?? "") ? params.get("state") : null;
  const text = params.get("q") ?? "";
  const runOptions = useRunChoices(projectId, run, t);
  const [creating, setCreating] = useState(false);
  const context = useRunAgreements(projectId, run);
  const title = <PageTitle>{t("agreements.title")}</PageTitle>;
  const stateOptions = [{ value: "all", label: t("agreements.filter.all") }, ...STATE_FILTERS.map((s) => ({ value: s, label: t((s === "locked" ? "agreements.filter.locked" : `agreements.state.${s}`) as ProductCopyKey) }))];
  return (
    <div className="grid min-h-full content-start bg-app" data-testid="agreements-screen">
      {title}
      <QueryBoundary query={q} loadingLabel={t("agreements.loading")} title={title} height="50vh">
        {(d) => {
          const name = d.agreements.find((a) => a.slug === open)?.name ?? "";
          const received = run && open ? ([...(context.data?.reached ?? [])].reverse().find((r) => r.kind === "agreement" && r.ref === open)?.revision ?? null) : null;
          return (
            <>
              <ListToolbar>
                <ListSearch noun={t("agreements.noun")} value={text} onChange={(v) => setParams({ q: v || null })} />
                <ToolbarSelect label={t("agreements.filter.state")} value={state ?? "all"} onChange={(v) => setParams({ state: v === "all" ? null : v })} options={stateOptions} />
                <ToolbarSelect label={t("agreements.run.label")} value={run ?? CURRENT} onChange={(v) => setParams({ run: v === CURRENT ? null : v })} options={runOptions} />
                {canManage && !run ? (
                  <Button type="button" size="sm" icon="plus" className="ml-auto" onClick={() => setCreating(true)} data-testid="agreement-new">
                    {t("agreements.act.new")}
                  </Button>
                ) : null}
              </ListToolbar>
              <Rules d={d} projectId={projectId} run={run} selected={open} onOpen={(s) => setParams({ agreement: s })} needle={text.trim().toLowerCase()} state={state} />
              <AgreementInspector projectId={projectId} slug={slug} open={open} name={name} canManage={canManage} received={received} onClose={() => setParams({ agreement: null })} />
              {canManage ? <NewAgreement projectId={projectId} open={creating} onClose={() => setCreating(false)} t={t} /> : null}
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

/** A project-only agreement of the project's own, written from a drawer. */
function NewAgreement({ projectId, open, onClose, t }: { projectId: string; open: boolean; onClose: () => void; t: Copy }) {
  return (
    <DetailDrawer label={t("agreements.act.new")} trigger={false} open={open} onOpenChange={(o) => (o ? undefined : onClose())} width={520}>
      {open ? <AgreementEdit projectId={projectId} a={null} onDone={onClose} /> : null}
    </DetailDrawer>
  );
}
