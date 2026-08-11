"use client";

// Project settings → Pipeline → "Plugins & agent config" (ISS-813, read-only Phase 1).
//
// Surfaces agentConfig.plugins + agentConfig.stateContext. Both live in
// `agentConfig` — there is no dedicated route for either, so this reads the
// same `GET /api/projects/:id` the rest of Settings already calls
// (`useProject` dedupes on the `['project', id]` query key) and shares one
// loading/error branch across both blocks.

import { Badge, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProject } from "@/features/projects/hooks";
import type { ProjectAgentConfig } from "../types";

function asAgentConfig(raw: unknown): ProjectAgentConfig {
  return raw && typeof raw === "object" ? (raw as ProjectAgentConfig) : {};
}

function formatBudget(budget: { perRunUsd?: number; perMonthUsd?: number; action?: string }): string {
  const parts: string[] = [];
  if (budget.perRunUsd != null) parts.push(`$${budget.perRunUsd}/run`);
  if (budget.perMonthUsd != null) parts.push(`$${budget.perMonthUsd}/mo`);
  const suffix = budget.action ? ` (${budget.action})` : "";
  return parts.length > 0 ? `${parts.join(" · ")}${suffix}` : "—";
}

export function AgentConfigSection({ projectId }: { projectId: string }) {
  const projectQ = useProject(projectId);

  if (projectQ.isLoading) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        <h3 className="fg-label text-fg">Plugins &amp; agent config</h3>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-2/3 rounded-md" />
        </div>
      </div>
    );
  }

  if (projectQ.isError) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        <h3 className="fg-label text-fg">Plugins &amp; agent config</h3>
        <ErrorState
          message={formatApiError(projectQ.error)}
          onRetry={() => projectQ.refetch()}
        />
      </div>
    );
  }

  const agentConfig = asAgentConfig(projectQ.data?.agentConfig);
  const plugins = agentConfig.plugins ?? [];
  const stateContextEntries = Object.entries(agentConfig.stateContext ?? {});

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Plugins &amp; agent config</h3>

      <div className="mt-3">
        <p className="fg-label text-fg">Plugins</p>
        {plugins.length === 0 ? (
          <p className="fg-body-sm text-muted">No plugins designated for this project.</p>
        ) : (
          <>
            <p className="fg-caption mb-2 text-muted">
              Installed at DEVICE scope — a device installs the union of every project it serves,
              not just this one.
            </p>
            <div className="divide-y divide-line">
              {plugins.map((p) => (
                <div
                  key={`${p.marketplace}/${p.name}`}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="fg-label truncate text-fg">
                      {p.marketplace}/{p.name}
                    </p>
                    {p.pinnedRef && (
                      <p className="fg-caption font-mono text-muted" title={p.pinnedRef}>
                        {p.pinnedRef.slice(0, 7)}
                      </p>
                    )}
                  </div>
                  <Badge tone={p.autoUpdate ? "green" : "neutral"}>
                    {p.autoUpdate ? "auto-update" : "pinned"}
                  </Badge>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="mt-4">
        <p className="fg-label text-fg">Per-state context</p>
        {stateContextEntries.length === 0 ? (
          <p className="fg-body-sm text-muted">Not configured.</p>
        ) : (
          <div className="divide-y divide-line">
            {stateContextEntries.map(([jobType, entry]) => (
              <div key={jobType} className="py-2">
                <p className="fg-label text-fg">{jobType}</p>
                {entry.modelOverride && (
                  <p className="fg-caption text-muted">Model override: {entry.modelOverride}</p>
                )}
                {entry.budget && (
                  <p className="fg-caption text-muted">Budget: {formatBudget(entry.budget)}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
