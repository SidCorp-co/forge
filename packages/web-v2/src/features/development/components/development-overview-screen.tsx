"use client";

import { EmptyState, ErrorState, PageTitle, ProjectLoader, ViewHeading, WaitBanner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useDevelopmentOverview } from "../hooks";
import type { DevelopmentOverview } from "../types";
import { IssueFlow } from "./issue-flow";
import { LeaseLanes } from "./lease-lanes";
import { ModuleBars } from "./module-bars";
import { NeedsYou } from "./needs-you";
import { SignalsStrip } from "./signals-strip";
import { StuckChains } from "./stuck-chains";

const Count = ({ n }: { n: number }) => <span className="font-mono tabular-nums">{n}</span>;

const Note = ({ children }: { children: string }) => <span className="text-12-5 font-normal text-muted">{children}</span>;

function Coverage({ c }: { c: DevelopmentOverview["coverage"] }) {
  if (c.openRead >= c.open && !c.flowTruncated) return null;
  return (
    <WaitBanner
      tone="calm"
      head="Partial read."
      body={
        c.openRead < c.open
          ? `This page reads the newest ${c.openRead} of ${c.open} open issues, so counts below it are short.`
          : `The issue flow counts the newest ${c.limit} closed issues only.`
      }
      className="border-b border-line-subtle"
      testId="overview-partial"
    />
  );
}

export function DevelopmentOverviewScreen({ scope }: { scope: { projectId: string; slug: string } }) {
  const q = useDevelopmentOverview(scope.projectId);
  const d = q.data;
  return (
    <>
      <PageTitle hint="What is running, what is stuck and what waits on you, read from core.">Development overview</PageTitle>
      <div className="flex min-h-full flex-col bg-app pb-8" data-testid="development-overview">
        {q.isLoading ? (
          <div className="grid min-h-[50vh] place-items-center">
            <ProjectLoader label="loading the overview…" />
          </div>
        ) : q.isError || !d ? (
          <div className="grid min-h-[50vh] place-items-center">
            <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
          </div>
        ) : (
          <>
            <SignalsStrip data={d} />
            <Coverage c={d.coverage} />
            <div className="grid gap-x-14 gap-y-9 px-5 py-6 max-md:px-3 lg:grid-cols-2">
              <div className="min-w-0 space-y-9">
                <section aria-label="Issue flow">
                  <ViewHeading right={<Note>{`Last ${d.flow.windowDays} days · ${d.flow.total} issues`}</Note>}>Issue flow</ViewHeading>
                  <IssueFlow flow={d.flow} />
                </section>
                <section aria-label="Moving">
                  <ViewHeading right={<Note>Runs holding a lease</Note>}>
                    Moving <Count n={d.moving.count} />
                  </ViewHeading>
                  <LeaseLanes moving={d.moving} slug={scope.slug} />
                </section>
              </div>
              <div className="min-w-0 space-y-9">
                <section aria-label="Stuck">
                  <ViewHeading right={<Note>Read from the root; unblocking it frees the chain</Note>}>
                    Stuck <Count n={d.stuck.count} />
                  </ViewHeading>
                  <StuckChains stuck={d.stuck} slug={scope.slug} />
                </section>
                <section aria-label="Modules">
                  <ViewHeading right={<Note>Open issues by state</Note>}>Modules</ViewHeading>
                  <ModuleBars modules={d.modules} />
                </section>
              </div>
            </div>
            {d.flow.total === 0 && d.needsYou.count === 0 && d.stuck.count === 0 && d.moving.count === 0 ? (
              <EmptyState title="Nothing is moving yet" message="Issues appear here once someone files or works one." />
            ) : null}
            <NeedsYou needs={d.needsYou} slug={scope.slug} />
          </>
        )}
      </div>
    </>
  );
}
