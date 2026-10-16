// Which steps of each linked design serve each criterion (REQ-17 BC-10): picked per criterion and
// design, and written whole at once (`PUT …/criteria/<code>/steps`). A design's approval reads these
// traces (`workflows/design-checklist-record.ts`), so a requirement linking a design traces its
// criteria before that design is approved. The lines a trace already names go back as they are.

import { ChoiceChips, Disclosure } from "@/design";
import { titleOf, useWorkflows } from "@/features/workflows";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useTraceCriterion } from "../hooks";
import type { RequirementCriterion, RequirementDetail } from "../types";

/** The criteria a trace is written for: the open revision's while one is open, else the head's. */
function tracedCriteria(d: RequirementDetail): RequirementCriterion[] {
  return d.revisions.find((r) => r.state === "draft" || r.state === "proposed")?.criteria ?? d.criteria;
}

export function CriteriaTrace({ projectId, d }: { projectId: string; d: RequirementDetail }) {
  const t = useCopy();
  const designs = useWorkflows(projectId).data?.workflows ?? [];
  const trace = useTraceCriterion(projectId, d.key);
  const criteria = tracedCriteria(d);
  if (d.workflows.length === 0 || criteria.length === 0) return null;
  return (
    <section className="mt-8" data-testid="criteria-trace" aria-label={t("requirements.trace.heading")}>
      <h3 className="fg-h3 mb-2">{t("requirements.trace.heading")}</h3>
      {d.workflows.map((w) => {
        const design = designs.find((x) => x.document.id === w.workflowId);
        const steps = design?.document.steps ?? [];
        return (
          <Disclosure key={w.workflowId} title={w.title} testId="trace-design">
            <ul className="grid gap-3 pb-3">
              {criteria.map((c) => {
                const held = d.traces.find((x) => x.code === c.code && x.workflowId === w.workflowId);
                return (
                  <li key={c.code} className="grid gap-1.5" data-testid="trace-criterion" data-code={c.code}>
                    <span className="whitespace-pre-wrap text-13">{c.body}</span>
                    {steps.length === 0 ? null : (
                      <ChoiceChips
                        label={t("requirements.trace.stepsFor", { design: w.title })}
                        multiple
                        options={steps.map((s) => ({ value: s.id, label: titleOf(s) }))}
                        value={held?.steps ?? []}
                        onChange={(next) => trace.mutate({ code: c.code, body: { workflow: w.flow, steps: next, edges: held?.edges ?? [] } })}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </Disclosure>
        );
      })}
      <RefusalLine error={trace.error} testid="trace-refusal" />
    </section>
  );
}
