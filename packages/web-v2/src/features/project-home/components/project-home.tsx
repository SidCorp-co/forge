// The project home's first screen (REQ-41 BC-13): what needs you, and beside it, or below it on a
// phone, what is running and what is at risk. Flat tables on hairlines, no cards; each decision is
// drawn dense, its question and its buttons, since the Dashboard's figures sit above. The conversation
// is not drawn here: it opens from the top bar's Ask Agent, so the dashboard reads as state.
// Needs you is the one decisions read the chat answers from (`useNeedsYouDecisions`, `DecisionList`),
// at most `NEEDS_YOU_PERSON_CAP` at a time with the rest counted (REQ-48 BC-11). Under its title, one
// line says when the steward is quiet for its budget, so a person sees why (REQ-48 BC-1). A section
// that holds nothing is not drawn: never an empty title with "nothing" under it (ISS-903). Needs you
// stands while a decision waits or the steward is quiet for its budget.

import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { DecisionList } from "@/features/needs-you";
import { useNeedsYouDecisions } from "@/features/needs-you";
import { approvalsHref } from "@/lib/routes/approvals";
import { issuesHref } from "@/lib/routes/issues";
import { useProjectStatus } from "@/features/project-status";
import { StewardBudgetLine, useStewardBudget } from "@/features/standing";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { atRiskRows, runningRows, unlistedStuck } from "../derive";
import { AtRiskTable, HomeSectionTitle, RunningTable } from "./home-tables";

type DecisionsRead = ReturnType<typeof useNeedsYouDecisions>;
type StatusRead = ReturnType<typeof useProjectStatus>;

function NeedsYouDecisions({ projectId, slug, q }: { projectId: string; slug: string; q: DecisionsRead }) {
  const t = useCopy();
  return (
    <section id="needs-you" aria-label={t("home.needsYou")} data-testid="home-needs-you" className="min-w-0 scroll-mt-24 lg:flex-1">
      <HomeSectionTitle count={q.data?.total}>{t("home.needsYou")}</HomeSectionTitle>
      <StewardBudgetLine projectId={projectId} />
      {q.data && q.data.total > 0 ? (
        <DecisionList read={q.data} slug={slug} cap={NEEDS_YOU_PERSON_CAP} moreHref={approvalsHref(slug)} dense />
      ) : q.isError ? (
        <p className="fg-caption text-danger" role="alert">
          {formatApiError(q.error)}
        </p>
      ) : null}
    </section>
  );
}

/** Running and At risk, each only where it holds a row; null where neither does. */
function sideOf(q: StatusRead, slug: string) {
  const status = q.data;
  if (!status) return { status, running: [], atRisk: [], unlisted: 0, showRunning: false, showAtRisk: false };
  const running = runningRows(status);
  const atRisk = atRiskRows(status, slug);
  const unlisted = unlistedStuck(status);
  return { status, running, atRisk, unlisted, showRunning: running.length > 0 || status.inFlight.runningCount > 0, showAtRisk: atRisk.length + unlisted > 0 };
}

export function ProjectHome({ projectId, slug }: { projectId: string; slug: string }) {
  const decisionsQ = useNeedsYouDecisions(projectId);
  const statusQ = useProjectStatus(projectId);
  const quiet = useStewardBudget(projectId);
  const needsYou = decisionsQ.isError || (decisionsQ.data?.total ?? 0) > 0 || !!quiet;
  const side = sideOf(statusQ, slug);
  const sideShown = statusQ.isError || side.showRunning || side.showAtRisk;
  if (!needsYou && !sideShown) return null;
  return (
    <div className="flex flex-col gap-6 lg:flex-row" data-testid="project-home">
      {needsYou ? <NeedsYouDecisions projectId={projectId} slug={slug} q={decisionsQ} /> : null}
      {sideShown ? (
        <div className={needsYou ? "flex min-w-0 flex-col gap-6 lg:w-104 lg:flex-none" : "flex min-w-0 flex-1 flex-col gap-6"}>
          {statusQ.isError ? (
            <p className="fg-caption text-danger" role="alert">
              {formatApiError(statusQ.error)}
            </p>
          ) : null}
          {side.status && side.showRunning ? <RunningTable rows={side.running} total={side.status.inFlight.runningCount} slug={slug} /> : null}
          {side.showAtRisk ? <AtRiskTable rows={side.atRisk} unlisted={side.unlisted} moreHref={issuesHref(slug)} /> : null}
        </div>
      ) : null}
    </div>
  );
}
