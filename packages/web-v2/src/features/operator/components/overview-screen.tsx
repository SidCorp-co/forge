"use client";

import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorState, SegmentedControl } from "@/design";
import { formatApiError } from "@/lib/api/error";
import {
  useOperatorAdoption,
  useOperatorAlerts,
  useOperatorLiveRooms,
  useOperatorOverview,
  useOperatorWorkspaces,
} from "../hooks";
import type { OperatorWindow, OperatorWorkspaceSort } from "../types";
import { AdoptionPanel, AdoptionPanelSkeleton } from "./adoption-panel";
import { AlertFeed, AlertFeedSkeleton } from "./alert-feed";
import { GlanceCards, GlanceCardsSkeleton } from "./glance-cards";
import { KpiRow, KpiRowSkeleton } from "./kpi-row";
import { WorkspacesTable, WorkspacesTableSkeleton } from "./workspaces-table";
import { SectionTitle, PageTitle } from "@/design/primitives/heading";

const WINDOWS: { value: OperatorWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

/**
 * One panel's loading / error / data fork, so a single dead endpoint costs its
 * own card and not the page. Four independent queries means four independent
 * failures, and an operator with three working panels is better served than one
 * looking at a whole-screen error.
 */
function Panel<T>({
  query,
  what,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  /** What the panel shows, for the title of its failure: "Couldn't load {what}". */
  what: string;
  skeleton: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <>{skeleton}</>;
  if (query.isError) {
    return (
      <ErrorState
        title={`Couldn't load ${what}`}
        message={formatApiError(query.error)}
        onRetry={() => void query.refetch()}
        mascot={false}
      />
    );
  }
  return <>{children(query.data)}</>;
}

export function OperatorOverviewScreen() {
  const [window, setWindow] = useState<OperatorWindow>("24h");
  const [sort, setSort] = useState<OperatorWorkspaceSort>("runs");

  const overview = useOperatorOverview(window);
  const alerts = useOperatorAlerts();
  const adoption = useOperatorAdoption();
  const workspaces = useOperatorWorkspaces(window, sort);

  useOperatorLiveRooms(workspaces.data?.items.map((w) => w.projectId) ?? []);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle className="fg-h2">Deployment overview</PageTitle>
        <SegmentedControl options={WINDOWS} value={window} onChange={setWindow} />
      </div>

      <Panel query={overview} what="the key figures" skeleton={<KpiRowSkeleton />}>
        {(data) => <KpiRow overview={data} />}
      </Panel>

      <Panel query={alerts} what="alerts" skeleton={<AlertFeedSkeleton />}>
        {(data) => <AlertFeed alerts={data.items} />}
      </Panel>

      <section className="flex flex-col gap-3">
        <SectionTitle className="fg-h3">Glance</SectionTitle>
        <Panel query={overview} what="the glance figures" skeleton={<GlanceCardsSkeleton />}>
          {(data) => <GlanceCards glance={data.glance} />}
        </Panel>
      </section>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <Panel query={adoption} what="adoption" skeleton={<AdoptionPanelSkeleton />}>
          {(data) => <AdoptionPanel buckets={data} />}
        </Panel>
        <Panel query={workspaces} what="workspaces" skeleton={<WorkspacesTableSkeleton />}>
          {(data) => <WorkspacesTable rows={data.items} sort={sort} onSortChange={setSort} busy={workspaces.isPlaceholderData} />}
        </Panel>
      </div>
    </div>
  );
}
