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
// The pools are the `deviceIds` of each stage in the page's draft, saved with the rest of it.

import Link from "next/link";
import { useMemo } from "react";
import {
  Banner,
  Button,
  CardTitle,
  Checkbox,
  HealthDot,
  Icon,
  ReadFailedLine,
  type SettingsForm,
  Skeleton,
} from "@/design";
import { useProjectRunners } from "@/features/runners/hooks";
import { formatApiError } from "@/lib/api/error";
import type { ProjectRunner } from "@/features/runners/types";
import type { PipelineDraft } from "../pipeline-form";
import { PIPELINE_STATUS_ROWS } from "../types";

/** The devices a pool names that no runner on this project answers for. The server refuses a
 *  save that keeps one, so the page holds its Save while any is named. `null` is runners not read,
 *  which names no device unknown (ISS-1229 r48). */
export function unknownPoolDevices(
  states: PipelineDraft["states"],
  runners: readonly { deviceId?: string | null }[] | null,
): string[] {
  if (runners === null) return [];
  const known = new Set(runners.map((r) => r.deviceId));
  const out = new Set<string>();
  for (const st of Object.values(states)) for (const id of st.deviceIds) if (!known.has(id)) out.add(id);
  return [...out];
}

/** Why this runner cannot take work right now, or null when it can. */
function blockedReason(r: ProjectRunner): string | null {
  if (r.deviceDisabledAt) return "turned off";
  if (r.deviceStatus === "revoked") return "revoked";
  // A draining or disabled runner is up and reporting and taking nothing, so
  // calling it offline contradicted the release blocker naming the same box as
  // up, a few hundred pixels above on this same tab (ISS-1127).
  if (r.runnerStatus === "draining" || r.runnerStatus === "disabled") return "out of the pool";
  if (r.deviceStatus !== "online" || r.runnerStatus !== "online") return "offline";
  if (r.limitReason === "usage_limit") return "spend limit";
  if (r.limitReason === "rate_limit") return "rate limited";
  if (r.limitReason === "auth") return "auth expired";
  return null;
}

export function RunnerPoolsSection({
  projectId,
  form,
  canEdit,
  slug,
}: {
  projectId: string;
  form: SettingsForm<PipelineDraft>;
  canEdit: boolean;
  /** Where the Runners tab is, for the prerequisite this matrix names when no runner is paired. */
  slug?: string;
}) {
  const runnersQuery = useProjectRunners(projectId);
  const runners = useMemo(
    () => (runnersQuery.data ?? []).filter((r): r is ProjectRunner & { deviceId: string } => !!r.deviceId),
    [runnersQuery.data],
  );

  const states = form.draft.states;
  const pools = (status: string): string[] => states[status]?.deviceIds ?? [];
  const runnersRead = runnersQuery.data !== undefined;
  const staleIds = useMemo(
    () => unknownPoolDevices(states, runnersRead ? runners : null),
    [states, runners, runnersRead],
  );

  function setPool(status: string, next: (current: string[]) => string[]) {
    form.setDraft((d) => {
      const stage = d.states[status];
      if (!stage) return d;
      return {
        ...d,
        states: { ...d.states, [status]: { ...stage, deviceIds: next(stage.deviceIds).sort() } },
      };
    });
  }

  function toggle(status: string, deviceId: string) {
    setPool(status, (cur) => (cur.includes(deviceId) ? cur.filter((d) => d !== deviceId) : [...cur, deviceId]));
  }

  function clearStage(status: string) {
    setPool(status, () => []);
  }

  return (
    <div className="mt-6 border-t border-line pt-5">
      <CardTitle className="fg-label text-fg">Runner pools</CardTitle>
      <p className="fg-body-sm mb-3 text-muted">
        Pin a stage to specific machines — to compare models side by side, or to keep one box for one
        kind of work. A stage with nothing ticked runs on <strong>any runner</strong>. Inside a pool
        everything else still applies: a busy, rate-limited or offline member is skipped and the job
        goes to another member. When <strong>every</strong> member is unavailable the jobs wait
        rather than leaking onto a machine outside the pool.
      </p>

      {runnersQuery.isError && !runnersRead ? (
        <ReadFailedLine
          what="this project's runners"
          why={formatApiError(runnersQuery.error)}
          error={runnersQuery.error} onRetry={() => void runnersQuery.refetch()}
        />
      ) : runnersQuery.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : runners.length === 0 ? (
        <div data-testid="runner-pools-unavailable">
          <p className="fg-body-sm text-fg">
            Pair a runner with this project first: a pool is chosen from its runners, and it has none.{" "}
            {slug && (
              <Link href={`/projects/${slug}/settings?tab=runners`} className="text-accent-text hover:underline">
                Go to Runners
              </Link>
            )}
          </p>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {PIPELINE_STATUS_ROWS.map((stage) => {
              const stale = pools(stage.status).length > 0;
              return (
                <li key={stage.status} className="flex items-center justify-between gap-3 py-2">
                  <p className="fg-label text-fg">
                    {stage.label}
                    {stale && (
                      <span className="fg-caption ml-2 text-muted">pinned to a device no runner answers for</span>
                    )}
                  </p>
                  {stale && canEdit ? (
                    <Button variant="ghost" size="sm" onClick={() => clearStage(stage.status)}>
                      Clear
                    </Button>
                  ) : (
                    <Checkbox
                      checked={false}
                      disabled
                      ariaLabel={`${stage.label}: pin to a runner (pair a runner first)`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="overflow-x-auto border-y border-line">
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
                const selected = pools(stage.status);
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

      {runners.length > 0 && staleIds.length > 0 && (
        <div className="mt-3">
          <Banner tone="attention">
            {staleIds.length === 1 ? "A pool names a device" : "Pools name devices"} with no runner
            on this project ({staleIds.map((d) => d.slice(0, 8)).join(", ")}). The server rejects a
            save that keeps {staleIds.length === 1 ? "it" : "them"} — the row above shows no column
            for {staleIds.length === 1 ? "it" : "them"}, so clear that stage to drop it.
          </Banner>
        </div>
      )}
    </div>
  );
}
