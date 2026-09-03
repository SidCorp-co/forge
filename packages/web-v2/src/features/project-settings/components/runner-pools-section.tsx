"use client";

// Project settings → Pipeline → "Runner pools".
//
// A pool narrows which devices a stage's jobs may land on
// (`states[<status>].deviceIds`). Every other selection rule — liveness,
// rate-limit, quarantine, load-aware pick, retry rotation — still applies
// INSIDE the pool. No selection = the whole fleet.
//
// Rendered as a stage × runner matrix so the answer to "where does Review
// run?" is one row, and "what does this box run?" is one column.
//
// Save-island contract, same as session-groups-section.tsx: take the full
// fetched config, edit one slice, resend the FULL `states` map (the PATCH
// merge is wholesale-replace at that key) with every sibling key spread
// through untouched.

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, HealthDot, Icon, Skeleton } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useProjectRunners } from "@/features/runners/hooks";
import type { ProjectRunner } from "@/features/runners/types";
import { useUpdatePipelineConfig } from "../hooks";
import { PIPELINE_STATUS_ROWS, type PipelineConfig } from "../types";

type StatesMap = Record<string, Record<string, unknown>>;
type PoolMap = Record<string, string[]>;

function asStates(config: PipelineConfig): StatesMap {
  const s = config.states;
  return s && typeof s === "object" ? (s as StatesMap) : {};
}

function seedPools(config: PipelineConfig): PoolMap {
  const out: PoolMap = {};
  for (const [status, st] of Object.entries(asStates(config))) {
    const ids = st?.deviceIds;
    if (Array.isArray(ids)) {
      const clean = ids.filter((d): d is string => typeof d === "string");
      if (clean.length > 0) out[status] = clean;
    }
  }
  return out;
}

function snapshot(pools: PoolMap): string {
  const keys = Object.keys(pools)
    .filter((k) => (pools[k]?.length ?? 0) > 0)
    .sort();
  return JSON.stringify(keys.map((k) => [k, [...pools[k]].sort()]));
}

/** Why this runner cannot take work right now, or null when it can. */
function blockedReason(r: ProjectRunner): string | null {
  if (r.deviceDisabledAt) return "turned off";
  if (r.deviceStatus === "revoked") return "revoked";
  if (r.deviceStatus !== "online" || r.runnerStatus !== "online") return "offline";
  if (r.limitReason === "usage_limit") return "spend limit";
  if (r.limitReason === "rate_limit") return "rate limited";
  if (r.limitReason === "auth") return "auth expired";
  return null;
}

export function RunnerPoolsSection({
  projectId,
  config,
  canEdit,
}: {
  projectId: string;
  config: PipelineConfig;
  canEdit: boolean;
}) {
  const update = useUpdatePipelineConfig(projectId);
  const runnersQuery = useProjectRunners(projectId);
  const runners = useMemo(
    () => (runnersQuery.data ?? []).filter((r): r is ProjectRunner & { deviceId: string } => !!r.deviceId),
    [runnersQuery.data],
  );

  const seeded = useMemo(() => seedPools(config), [config]);
  const [pools, setPools] = useState<PoolMap>(seeded);
  useEffect(() => {
    setPools(seedPools(config));
  }, [config]);

  const dirty = snapshot(pools) !== snapshot(seeded);

  // cm:why the server rejects a pool naming a device with no runner on this project (STAGE_POOL_UNKNOWN_RUNNER), so a retired box turns every later save into a 400 — name the stale ids instead of letting the operator guess which chip is poison
  const known = useMemo(() => new Set(runners.map((r) => r.deviceId)), [runners]);
  const staleIds = useMemo(() => {
    const out = new Set<string>();
    for (const ids of Object.values(pools)) for (const id of ids) if (!known.has(id)) out.add(id);
    return [...out];
  }, [pools, known]);

  function toggle(status: string, deviceId: string) {
    setPools((p) => {
      const cur = p[status] ?? [];
      return {
        ...p,
        [status]: cur.includes(deviceId) ? cur.filter((d) => d !== deviceId) : [...cur, deviceId],
      };
    });
  }

  function clearStage(status: string) {
    setPools((p) => ({ ...p, [status]: [] }));
  }

  function save() {
    const nextStates: StatesMap = {};
    for (const [status, st] of Object.entries(asStates(config))) {
      const base: Record<string, unknown> = st && typeof st === "object" ? { ...st } : {};
      const ids = pools[status] ?? [];
      if (ids.length > 0) base.deviceIds = ids;
      else delete base.deviceIds;
      nextStates[status] = base;
    }
    for (const [status, ids] of Object.entries(pools)) {
      if (ids.length > 0 && !(status in nextStates)) nextStates[status] = { deviceIds: ids };
    }
    update.mutate({ ...config, states: nextStates });
  }

  const saveDisabled = !dirty || staleIds.length > 0 || update.isPending;

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Runner pools</h3>
      <p className="fg-body-sm mb-3 text-muted">
        Pin a stage to specific machines — to compare models side by side, or to keep one box for one
        kind of work. A stage with nothing ticked runs on <strong>any runner</strong>. Inside a pool
        everything else still applies: a busy, rate-limited or offline member is skipped and the job
        goes to another member. When <strong>every</strong> member is unavailable the jobs wait
        rather than leaking onto a machine outside the pool.
      </p>

      {runnersQuery.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : runners.length === 0 ? (
        <div className="rounded-md border border-line bg-sunken px-3 py-3">
          <p className="fg-body-sm text-muted">
            No device runner is bound to this project, so there is nothing to pool. Pair a device on
            the Runners tab first.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-sunken">
                <th className="fg-caption sticky left-0 z-10 bg-sunken px-3 py-2 text-left text-muted">
                  Stage
                </th>
                {runners.map((r) => {
                  const reason = blockedReason(r);
                  return (
                    <th key={r.deviceId} className="px-3 py-2 text-center align-bottom">
                      <div className="fg-caption max-w-32 truncate text-fg" title={r.deviceName ?? r.deviceId}>
                        {r.deviceName ?? r.deviceId.slice(0, 8)}
                      </div>
                      {reason ? (
                        <div className="fg-caption text-subtle">{reason}</div>
                      ) : (
                        <div className="flex justify-center">
                          <HealthDot health="healthy" withLabel={false} />
                        </div>
                      )}
                    </th>
                  );
                })}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {PIPELINE_STATUS_ROWS.map((stage) => {
                const selected = pools[stage.status] ?? [];
                const members = runners.filter((r) => selected.includes(r.deviceId));
                const allBlocked = members.length > 0 && members.every((r) => blockedReason(r) !== null);
                return (
                  <tr key={stage.status} className="border-line border-t">
                    <td className="sticky left-0 z-10 bg-surface px-3 py-2">
                      <div className="fg-label text-fg">{stage.label}</div>
                      <div className="fg-caption font-mono text-subtle">{stage.status}</div>
                      {allBlocked && (
                        <div
                          className="fg-caption mt-1 flex items-center gap-1"
                          style={{ color: "var(--amberw-600)" }}
                        >
                          <Icon name="alert" size={12} />
                          Whole pool unavailable — jobs wait
                        </div>
                      )}
                    </td>
                    {runners.map((r) => {
                      const on = selected.includes(r.deviceId);
                      return (
                        <td key={r.deviceId} className="px-3 py-2 text-center">
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => toggle(stage.status, r.deviceId)}
                            aria-pressed={on}
                            aria-label={`${stage.label} on ${r.deviceName ?? r.deviceId}`}
                            className={
                              on
                                ? "inline-flex h-6 w-6 items-center justify-center rounded-md border border-accent-text bg-accent-tint text-accent-text"
                                : "inline-flex h-6 w-6 items-center justify-center rounded-md border border-line text-subtle hover:border-accent-text"
                            }
                          >
                            {on && <Icon name="check" size={14} />}
                          </button>
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {selected.length === 0 ? (
                        <span className="fg-caption text-subtle">Any runner</span>
                      ) : canEdit ? (
                        <Button variant="ghost" size="sm" onClick={() => clearStage(stage.status)}>
                          Clear
                        </Button>
                      ) : (
                        <span className="fg-caption text-muted">
                          {selected.length === 1 ? "1 pinned" : `${selected.length} runners`}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {runners.length > 0 && (
        <div className="mt-3 space-y-3">
          {staleIds.length > 0 && (
            <Banner tone="attention">
              {staleIds.length === 1 ? "A pool names a device" : "Pools name devices"} with no runner
              on this project ({staleIds.map((d) => d.slice(0, 8)).join(", ")}). The server rejects a
              save that keeps {staleIds.length === 1 ? "it" : "them"} — the row above shows no column
              for {staleIds.length === 1 ? "it" : "them"}, so clear that stage to drop it.
            </Banner>
          )}

          {update.isError && (
            <Banner tone="danger" onDismiss={() => update.reset()}>
              {formatPipelineConfigError(update.error)}
            </Banner>
          )}

          {update.isSuccess && !dirty && (
            <Banner tone="success" onDismiss={() => update.reset()}>
              Runner pools saved.
            </Banner>
          )}

          {canEdit && (
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={saveDisabled}
              onClick={save}
              className="min-h-11"
            >
              Save runner pools
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
