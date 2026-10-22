// One line on the Dashboard when the steward is quiet for its budget (REQ-48 BC-1): the whole day
// spent, so no handoff gets a run until it resets, or only the sweep's share, so stuck items wait for
// tomorrow while handoffs still run. Nothing is drawn while the steward has budget.

import type { StewardBudgetView } from "@forge/contracts/steward-runtime";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useStewardBudget } from "../hooks";

export function StewardBudgetSentence({ budget }: { budget: StewardBudgetView }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (!budget.quiet) return null;
  const text =
    budget.quiet === "handoffs"
      ? t("steward.budget.spent", { at: time.dateTime(budget.resumesAt) })
      : budget.paced > 0
        ? t("steward.budget.sweepPaced", { n: budget.paced })
        : t("steward.budget.sweepSpent");
  return (
    <p className="border-b border-line-subtle py-2 text-13 text-muted" data-testid="steward-budget-line" data-quiet={budget.quiet}>
      {text}
    </p>
  );
}

export function StewardBudgetLine({ projectId }: { projectId: string }) {
  const budget = useStewardBudget(projectId);
  return budget ? <StewardBudgetSentence budget={budget} /> : null;
}
