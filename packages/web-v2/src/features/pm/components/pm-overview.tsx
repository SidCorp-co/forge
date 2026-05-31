"use client";

// PM Overview tab: a client-derived snapshot (project health rollup) + runner
// load (from GET /api/runners?projectId) + a force-run control. PM
// snapshot/runner-load have no REST route — these are derived from real REST
// per the ISS-296 API-surface finding.
import { useMemo } from "react";
import { Button, Card, CardContent, HealthDot } from "@/design";
import { useProjectHealth } from "@/features/projects/hooks";
import { useProjectRunners } from "@/features/runners/hooks";
import { runnerHealth } from "@/features/runners/types";
import { useRunPm } from "../hooks";

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "alert" }) {
  return (
    <Card>
      <CardContent>
        <p className="fg-caption">{label}</p>
        <p
          className="mt-1 font-mono text-2xl font-bold"
          style={{ color: tone === "alert" ? "var(--red-600)" : "var(--fg-default)" }}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

export function PmOverview({ projectId }: { projectId: string }) {
  const healthQ = useProjectHealth();
  const runnersQ = useProjectRunners(projectId);
  const runPm = useRunPm(projectId);

  const health = useMemo(
    () => healthQ.data?.find((h) => h.id === projectId),
    [healthQ.data, projectId],
  );
  const runners = runnersQ.data?.runners ?? [];
  const online = runners.filter((r) => r.status === "online").length;
  const busy = runners.filter((r) => r.status === "draining").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="fg-body-sm">
          Snapshot derived from live pipeline health and the project's runner pool.
        </p>
        <Button variant="secondary" size="sm" icon="play" loading={runPm.isPending} onClick={() => runPm.mutate()}>
          Run PM now
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <StatTile label="Active issues" value={String(health?.totalActive ?? "—")} />
        <StatTile label="Throughput" value={String(health?.throughput ?? "—")} />
        <StatTile
          label="Blockers"
          value={String(health?.blockers?.length ?? 0)}
          tone={(health?.blockers?.length ?? 0) > 0 ? "alert" : undefined}
        />
        <StatTile
          label="Escalations"
          value={String(health?.pendingEscalations ?? 0)}
          tone={(health?.pendingEscalations ?? 0) > 0 ? "alert" : undefined}
        />
      </div>

      <Card>
        <CardContent>
          <div className="mb-3 flex items-center justify-between">
            <p className="fg-label">Runner load</p>
            <span className="fg-caption font-mono">
              {online} online · {busy} busy · {runners.length} total
            </span>
          </div>
          {runners.length === 0 ? (
            <p className="fg-caption">No runners assigned to this project.</p>
          ) : (
            <div className="space-y-2">
              {runners.map((r) => (
                <div key={r.id} className="flex items-center gap-2.5">
                  <HealthDot health={runnerHealth(r.status)} withLabel={false} />
                  <span className="fg-body-sm flex-1 truncate text-fg">{r.name}</span>
                  <span className="fg-caption font-mono">{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
