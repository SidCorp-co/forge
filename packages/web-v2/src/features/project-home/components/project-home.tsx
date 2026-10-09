"use client";

// The project home's first screen (REQ-41 BC-13): the conversation, and beside it, or below it on a
// phone, what needs you, what is running and what is at risk. Flat tables on hairlines, no cards.
// Needs you is the one decisions read the chat answers from (`useNeedsYouDecisions`, `DecisionList`).

import { DecisionList } from "@/features/needs-you/components/decision-list";
import { useNeedsYouDecisions } from "@/features/needs-you/hooks";
import { useProjectStatus } from "@/features/project-status/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { atRiskRows, runningRows } from "../derive";
import { HomeChat } from "./home-chat";
import { AtRiskTable, HomeSectionTitle, RunningTable } from "./home-tables";

export function ProjectHome({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const decisionsQ = useNeedsYouDecisions(projectId);
  const statusQ = useProjectStatus(projectId);
  const status = statusQ.data;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]" data-testid="project-home">
      <HomeChat projectId={projectId} />
      <div className="flex min-w-0 flex-col gap-6">
        <section aria-label={t("home.needsYou")} data-testid="home-needs-you">
          <HomeSectionTitle count={decisionsQ.data?.total}>{t("home.needsYou")}</HomeSectionTitle>
          {decisionsQ.data ? (
            <DecisionList read={decisionsQ.data} slug={slug} />
          ) : decisionsQ.isError ? (
            <p className="fg-caption text-danger" role="alert">
              {formatApiError(decisionsQ.error)}
            </p>
          ) : null}
        </section>
        {statusQ.isError ? (
          <p className="fg-caption text-danger" role="alert">
            {formatApiError(statusQ.error)}
          </p>
        ) : status ? (
          <>
            <RunningTable rows={runningRows(status)} total={status?.inFlight.runningCount ?? 0} slug={slug} />
            <AtRiskTable rows={atRiskRows(status, slug)} />
          </>
        ) : null}
      </div>
    </div>
  );
}
