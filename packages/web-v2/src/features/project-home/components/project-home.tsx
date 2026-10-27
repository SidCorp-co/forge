// The project home's first screen (REQ-41 BC-13): what needs you, and beside it, or below it on a
// phone, what is running and what is at risk. Flat tables on hairlines, no cards; each decision is
// drawn dense, its question and its buttons, since the Dashboard's figures sit above. The conversation
// is not drawn here: it opens from the top bar's Ask Agent, so the dashboard reads as state.
// Needs you is the one decisions read the chat answers from (`useNeedsYouDecisions`, `DecisionList`),
// at most `NEEDS_YOU_PERSON_CAP` at a time with the rest counted (REQ-48 BC-11). Under its title, one
// line says when the steward is quiet for its budget, so a person sees why (REQ-48 BC-1).

import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { DecisionList } from "@/features/needs-you";
import { useNeedsYouDecisions } from "@/features/needs-you";
import { approvalsHref } from "@/lib/routes/approvals";
import { issuesHref } from "@/lib/routes/issues";
import { useProjectStatus } from "@/features/project-status";
import { StewardBudgetLine } from "@/features/standing";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { atRiskRows, runningRows, unlistedStuck } from "../derive";
import { AtRiskTable, HomeSectionTitle, RunningTable } from "./home-tables";

export function ProjectHome({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const decisionsQ = useNeedsYouDecisions(projectId);
  const statusQ = useProjectStatus(projectId);
  const status = statusQ.data;
  return (
    <div className="flex flex-col gap-6 lg:flex-row" data-testid="project-home">
      <section id="needs-you" aria-label={t("home.needsYou")} data-testid="home-needs-you" className="min-w-0 scroll-mt-24 lg:flex-1">
        <HomeSectionTitle count={decisionsQ.data?.total}>{t("home.needsYou")}</HomeSectionTitle>
        <StewardBudgetLine projectId={projectId} />
        {decisionsQ.data ? (
          <DecisionList read={decisionsQ.data} slug={slug} cap={NEEDS_YOU_PERSON_CAP} moreHref={approvalsHref(slug)} dense />
        ) : decisionsQ.isError ? (
          <p className="fg-caption text-danger" role="alert">
            {formatApiError(decisionsQ.error)}
          </p>
        ) : null}
      </section>
      <div className="flex min-w-0 flex-col gap-6 lg:w-104 lg:flex-none">
        {statusQ.isError ? (
          <p className="fg-caption text-danger" role="alert">
            {formatApiError(statusQ.error)}
          </p>
        ) : status ? (
          <>
            <RunningTable rows={runningRows(status)} total={status.inFlight.runningCount} slug={slug} />
            <AtRiskTable rows={atRiskRows(status, slug)} unlisted={unlistedStuck(status)} moreHref={issuesHref(slug)} />
          </>
        ) : null}
      </div>
    </div>
  );
}
