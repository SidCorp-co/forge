// A project admin's ruling for a production act, given and withdrawn on the issue page (REQ-80 BC-11,
// ISS-1431): the act in their words and one of the project's production-tier environments, written
// through the issue's decision door as a `decision` naming the environment in `production`. While the
// issue is open, a run working it then reads that environment's protected variables, and the variables
// stay protected. Shown only to a project admin, on an open issue of a project declaring a
// production-tier environment; nobody else sees it.

import { ISSUE_TERMINAL_STATUSES } from "@forge/contracts/issue-machine";
import { useState } from "react";
import { Badge, Button, Field, Input, Select } from "@/design";
import { useProjectDocument } from "@/features/project-config";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useGiveRuling, useProductionRulings } from "../detail-hooks";
import { WithdrawForm } from "./activity-decision";
import { useIssueViewer } from "./use-issue-project";

const open = (status: string) => !(ISSUE_TERMINAL_STATUSES as readonly string[]).includes(status);

/** The environments a project document declares production-tier, by name. */
export function productionEnvironments(document: unknown): string[] {
  const environments = (document as { environments?: unknown } | null)?.environments;
  if (!environments || typeof environments !== "object") return [];
  return Object.entries(environments as Record<string, unknown>)
    .filter(([, e]) => (e as { tier?: unknown } | null)?.tier === "production")
    .map(([name]) => name);
}

export function ProductionRuling({ issue }: { issue: { id: string; projectId: string; status: string } }) {
  const t = useCopy();
  const viewer = useIssueViewer(issue.projectId);
  const offered = viewer.canManage && open(issue.status);
  const documentQ = useProjectDocument(offered ? issue.projectId : undefined);
  const environments = productionEnvironments(documentQ.data?.document ?? null);
  const rulingsQ = useProductionRulings(issue.id, offered && environments.length > 0);
  const [giving, setGiving] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  if (!offered || environments.length === 0) return null;
  const rulings = rulingsQ.data ?? [];
  return (
    <section className="pt-4" data-testid="production-ruling">
      <h3 className="mb-1 text-13 font-semibold text-muted" data-facts-title>
        {t("issues.ruling.title")}
      </h3>
      {rulings.length > 0 ? (
        <ul className="divide-y divide-line-divider">
          {rulings.map((r) => (
            <li key={r.id} className="grid gap-1.5 py-1.5" data-testid="production-ruling-row">
              <span className="flex min-w-0 items-center gap-2">
                <Badge tone="amber">{r.environment}</Badge>
                <span className="fg-body-sm min-w-0 flex-1 truncate" title={r.act}>
                  {r.act}
                </span>
                {withdrawing === r.id ? null : (
                  <button type="button" className="fg-caption shrink-0 hover:text-fg" onClick={() => setWithdrawing(r.id)}>
                    {t("issues.activity.withdraw")}
                  </button>
                )}
              </span>
              {withdrawing === r.id ? <WithdrawForm issueId={issue.id} eventId={r.id} onDone={() => setWithdrawing(null)} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {giving ? (
        <GiveRuling issueId={issue.id} environments={environments} onDone={() => setGiving(false)} />
      ) : (
        <button type="button" className="py-1.5 text-13 text-accent-text hover:underline" onClick={() => setGiving(true)}>
          {t("issues.ruling.give")}
        </button>
      )}
    </section>
  );
}

function GiveRuling({ issueId, environments, onDone }: { issueId: string; environments: string[]; onDone: () => void }) {
  const t = useCopy();
  const [act, setAct] = useState("");
  const [environment, setEnvironment] = useState(environments.length === 1 ? (environments[0] ?? "") : "");
  const give = useGiveRuling(issueId);
  const ready = act.trim().length >= 3 && environment !== "";
  return (
    <form
      className="grid gap-2 pt-1.5"
      data-testid="give-ruling"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) give.mutate({ act: act.trim(), environment }, { onSuccess: onDone });
      }}
    >
      <Field label={t("issues.ruling.act")}>
        <Input value={act} onChange={(e) => setAct(e.target.value)} maxLength={300} disabled={give.isPending} />
      </Field>
      <Field label={t("issues.ruling.environment")}>
        <Select
          options={environments.map((name) => ({ value: name, label: name }))}
          value={environment}
          onChange={setEnvironment}
          disabled={give.isPending}
        />
      </Field>
      <RefusalLine error={give.error} testid="give-ruling-refusal" />
      <span className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={give.isPending}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={give.isPending} disabled={!ready}>
          {t("issues.ruling.give")}
        </Button>
      </span>
    </form>
  );
}
