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
import { AlertFeed, AlertFeedSkeleton, openAlertCount } from "./alert-feed";
import { GlanceCards, GlanceCardsSkeleton } from "./glance-cards";
import { KpiRow, KpiRowSkeleton } from "./kpi-row";
import { WorkspacesTable, WorkspacesTableSkeleton } from "./workspaces-table";

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
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  skeleton: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <>{skeleton}</>;
  if (query.isError) {
    return (
      <ErrorState
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
        <h1 className="fg-h2">Deployment overview</h1>
        <SegmentedControl options={WINDOWS} value={window} onChange={setWindow} />
      </div>

      <Panel query={overview} skeleton={<KpiRowSkeleton />}>
        {(data) => (
          <KpiRow
            overview={data}
            openAlerts={alerts.data ? openAlertCount(alerts.data.items) : null}
          />
        )}
      </Panel>

      <Panel query={alerts} skeleton={<AlertFeedSkeleton />}>
        {(data) => <AlertFeed alerts={data.items} />}
      </Panel>

      <section className="flex flex-col gap-3">
        <h2 className="fg-h3">Glance</h2>
        <Panel query={overview} skeleton={<GlanceCardsSkeleton />}>
          {(data) => <GlanceCards glance={data.glance} />}
        </Panel>
      </section>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <Panel query={adoption} skeleton={<AdoptionPanelSkeleton />}>
          {(data) => <AdoptionPanel buckets={data} />}
        </Panel>
        <Panel query={workspaces} skeleton={<WorkspacesTableSkeleton />}>
          {(data) => <WorkspacesTable rows={data.items} sort={sort} onSortChange={setSort} />}
        </Panel>
      </div>
    </div>
  );
}
