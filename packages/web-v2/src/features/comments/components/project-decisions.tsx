"use client";

// The project's decision log (JU-5): every decision recorded on a requirement, an issue, a workflow
// design or a feedback item, newest first, narrowed by requirement (which takes in its issues),
// workflow, issue, who decided and when. Filters ride the URL so a narrowed log can be shared.

import { Input, PageTitle, ProjectLoader, Select, type SelectOption, useUrlParams } from "@/design";
import type { ReactNode } from "react";
import { type IssuePick, IssuePicker } from "@/features/issue-picker/issue-picker";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useProjectDecisions } from "../hooks";
import type { DecisionFilters } from "../types";
import { DecisionTarget } from "./decision-target";
import { DecisionRow } from "./decisions-panel";

const FILTER_KEYS = ["requirement", "workflow", "issue", "who", "since", "until"] as const;
const ANY = "";

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 text-12 text-muted">
      <span className="font-medium">{label}</span>
      {children}
    </div>
  );
}

/** The choices each filter offers beyond "Any": requirements and workflows by key, people by user id. */
export interface DecisionFilterOptions {
  requirements: SelectOption[];
  workflows: SelectOption[];
  who: SelectOption[];
}

export function ProjectDecisions({ projectId, slug, options }: { projectId: string; slug: string; options: DecisionFilterOptions }) {
  const t = useCopy();
  const [params, setParams] = useUrlParams();
  const filters: DecisionFilters = Object.fromEntries(FILTER_KEYS.flatMap((k) => (params.get(k) ? [[k, params.get(k) as string]] : [])));
  const q = useProjectDecisions(projectId, { ...filters, limit: 200 });
  const any: SelectOption = { value: ANY, label: t("decisions.filter.any") };
  const reqOptions = [any, ...options.requirements];
  const flowOptions = [any, ...options.workflows];
  const whoOptions = [any, ...options.who];
  const issue: IssuePick[] = filters.issue ? [{ key: filters.issue, title: "" }] : [];
  const set = (k: (typeof FILTER_KEYS)[number]) => (v: string) => setParams({ [k]: v || null });
  return (
    <div className="grid gap-6" data-testid="project-decisions">
      <PageTitle>{t("decisions.title")}</PageTitle>
      <p className="max-w-[80ch] text-13 text-muted">{t("decisions.lead")}</p>
      <div className="grid gap-3 border-b border-line-subtle pb-4 md:grid-cols-3" data-testid="decision-filters">
        <FilterField label={t("decisions.filter.requirement")}>
          <Select aria-label={t("decisions.filter.requirement")} options={reqOptions} value={filters.requirement ?? ANY} onChange={set("requirement")} />
        </FilterField>
        <FilterField label={t("decisions.filter.workflow")}>
          <Select aria-label={t("decisions.filter.workflow")} options={flowOptions} value={filters.workflow ?? ANY} onChange={set("workflow")} />
        </FilterField>
        <FilterField label={t("decisions.filter.issue")}>
          <IssuePicker projectId={projectId} value={issue} onChange={(next) => setParams({ issue: next[0]?.key ?? null })} ariaLabel={t("decisions.filter.issue")} single />
        </FilterField>
        <FilterField label={t("decisions.filter.who")}>
          <Select aria-label={t("decisions.filter.who")} options={whoOptions} value={filters.who ?? ANY} onChange={set("who")} />
        </FilterField>
        <FilterField label={t("decisions.filter.since")}>
          <Input type="date" aria-label={t("decisions.filter.since")} value={filters.since ?? ""} onChange={(e) => set("since")(e.target.value)} />
        </FilterField>
        <FilterField label={t("decisions.filter.until")}>
          <Input type="date" aria-label={t("decisions.filter.until")} value={filters.until ?? ""} onChange={(e) => set("until")(e.target.value)} />
        </FilterField>
      </div>
      {q.isLoading ? <ProjectLoader label={t("common.decisions.loading")} /> : null}
      {q.isError ? (
        <RefusalLine error={q.error} testid="decisions-refusal" />
      ) : q.data ? (
        q.data.decisions.length ? (
          <ul className="grid" data-testid="decision-log">
            {q.data.decisions.map((c) => (
              <DecisionRow key={c.id} c={c} onTarget={<DecisionTarget slug={slug} target={c.target} />} />
            ))}
          </ul>
        ) : (
          <p className="text-13 text-subtle">{t("decisions.none")}</p>
        )
      ) : null}
    </div>
  );
}

