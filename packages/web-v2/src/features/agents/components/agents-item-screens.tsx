"use client";

// cm:why a run's and the master's sticky header is the shared DetailHeader: back to the list view it was
// opened from, the key, the title, the state badge and the one primary act
import { DetailHeader, StatusBadge, useListOrigin } from "@/design";
import { useMasterStanding, useRunDetail } from "../hooks";
import { AGENTS_LIST, agentsListHref } from "../../../lib/routes/agents";
import { runName } from "../view";
import { MasterPage, masterName } from "./master-views";
import type { AgentsAccess } from "./runs-list";
import { RunActions, RunPage } from "./run-views";

export function RunItemScreen({ access, runId }: { access: AgentsAccess; runId: string }) {
  const r = useRunDetail(access.projectId, runId).data?.run;
  const back = useListOrigin(AGENTS_LIST, agentsListHref(access.slug));
  return (
    <div className="min-h-full bg-app" data-testid="run-item-screen">
      <DetailHeader
        back={{ href: back, label: "Agents / Runs" }}
        keyTitle={runId}
        title={r ? runName(r) : "Run"}
        badge={r ? <StatusBadge family="runStanding" value={r.state} /> : null}
        action={r ? <RunActions r={r} slug={access.slug} projectId={access.projectId} canWrite={access.canWrite} /> : null}
      />
      <RunPage projectId={access.projectId} slug={access.slug} runId={runId} />
    </div>
  );
}

export function MasterItemScreen({ access }: { access: AgentsAccess }) {
  const m = useMasterStanding(access.projectId).data;
  const back = useListOrigin(AGENTS_LIST, agentsListHref(access.slug));
  return (
    <div className="min-h-full bg-app" data-testid="master-item-screen">
      <DetailHeader
        back={{ href: back, label: "Agents / Runs" }}
        keyTitle={m?.sessionId ?? undefined}
        title={m ? masterName(m) : "Project master"}
        badge={m ? <StatusBadge family="masterState" value={m.state} /> : null}
      />
      <MasterPage projectId={access.projectId} slug={access.slug} />
    </div>
  );
}
