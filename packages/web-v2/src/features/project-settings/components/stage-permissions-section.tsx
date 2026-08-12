"use client";

// Project settings → Pipeline → "Stage permissions" (ISS-813, read-only Phase 1).
//
// Surfaces states[*].allowedTools/disallowedTools/mcpServers/skipComplexities/
// sessionGroup — set via the API today, invisible on this tab until now. Takes
// the already-fetched pipelineConfig (no query of its own) so it never flickers
// mid-edit. Collapsed by default per stage: the only way 176 entries across 9
// stages stay legible on one screen.
//
// No write controls here (deliberate — see ISS-813 plan §Step 5): `sessionGroup`
// stays a read-only echo (SessionGroupsSection below is the only editor), and
// full editability of the rest is ISS-814.

import { Badge, Collapsible, MonoTag } from "@/design";
import {
  denylistBaseline,
  humanizeToolName,
  summarizeStageConfig,
  type PipelineConfig,
} from "../types";

function groupByServer(tools: string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const raw of tools) {
    const { server } = humanizeToolName(raw);
    const key = server ?? "Built-in";
    const list = groups.get(key) ?? [];
    list.push(raw);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

function ToolChips({ tools }: { tools: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((raw) => {
        const { label } = humanizeToolName(raw);
        return (
          <span
            key={raw}
            title={raw}
            className="fg-caption max-w-full truncate rounded-pill border border-line px-2 py-0.5 text-muted"
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function namesOf(names: string[]): string {
  return names.map((raw) => humanizeToolName(raw).label).join(", ");
}

export function StagePermissionsSection({ config }: { config: PipelineConfig }) {
  const rows = summarizeStageConfig(config);
  const diffs = denylistBaseline(rows);
  const diffByStatus = new Map(diffs.map((d) => [d.status, d]));

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Stage permissions</h3>
      <p className="fg-body-sm mb-3 text-muted">
        What each stage&apos;s agent is allowed or denied, per-stage MCP overrides, complexity
        skips, and session group — read-only. Editability lands in a follow-up.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-md border border-line bg-sunken px-3 py-3">
          <p className="fg-body-sm text-muted">
            Every stage runs the default tool surface — no overrides set.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const denied = row.config.disallowedTools ?? [];
            const allowed = row.config.allowedTools ?? [];
            const mcpNames = Object.keys(row.config.mcpServers ?? {});
            const skips = row.config.skipComplexities ?? [];
            const pool = row.config.deviceIds ?? [];
            const diff = diffByStatus.get(row.status);

            return (
              <Collapsible
                key={row.status}
                title={
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{row.label}</span>
                    <MonoTag>{row.status}</MonoTag>
                    {denied.length > 0 && <Badge>{denied.length} denied</Badge>}
                    {allowed.length > 0 && <Badge>{allowed.length} allowed</Badge>}
                    {mcpNames.length > 0 && <Badge>{mcpNames.length} MCP</Badge>}
                    {row.config.sessionGroup && <Badge>group: {row.config.sessionGroup}</Badge>}
                    {pool.length > 0 && (
                      <Badge>{pool.length === 1 ? "1 pinned runner" : `${pool.length} runner pool`}</Badge>
                    )}
                    {skips.length > 0 && <Badge>skips {skips.join(", ")}</Badge>}
                    {diff?.isOutlier && <Badge tone="amber">Differs from the other stages</Badge>}
                  </div>
                }
              >
                <div className="space-y-3">
                  {denied.length > 0 && (
                    <div>
                      <p className="fg-caption mb-1 text-muted">Denied tools</p>
                      <div className="space-y-1.5">
                        {groupByServer(denied).map(([server, tools]) => (
                          <div key={server}>
                            <p className="fg-caption text-subtle">{server}</p>
                            <ToolChips tools={tools} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {diff && diff.missing.length > 0 && (
                    <p className="fg-caption text-muted">
                      Allows {diff.missing.length} tool{diff.missing.length === 1 ? "" : "s"} the
                      other stages deny: {namesOf(diff.missing)}.
                    </p>
                  )}
                  {diff && diff.extra.length > 0 && (
                    <p className="fg-caption text-muted">
                      Denies {diff.extra.length} tool{diff.extra.length === 1 ? "" : "s"} the other
                      stages allow: {namesOf(diff.extra)}.
                    </p>
                  )}

                  {allowed.length > 0 && (
                    <div>
                      <p className="fg-caption mb-1 text-muted">Allowed tools (allowlist)</p>
                      <ToolChips tools={allowed} />
                    </div>
                  )}

                  {mcpNames.length > 0 && (
                    <div>
                      <p className="fg-caption mb-1 text-muted">
                        MCP servers — overrides the project default above
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {mcpNames.map((n) => (
                          <MonoTag key={n}>{n}</MonoTag>
                        ))}
                      </div>
                    </div>
                  )}

                  {skips.length > 0 && (
                    <p className="fg-body-sm text-fg">
                      Skips this stage for complexity: {skips.join(", ")}
                    </p>
                  )}

                  {row.config.sessionGroup && (
                    <p className="fg-body-sm text-fg">
                      Session group: <MonoTag>{row.config.sessionGroup}</MonoTag> — edited in
                      Session groups below.
                    </p>
                  )}

                  {pool.length > 0 && (
                    <div>
                      <p className="fg-caption mb-1 text-muted">
                        Runner pool — this stage only runs on these devices. When all of them are
                        busy or limited, its jobs wait instead of moving to another runner.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {pool.map((d) => (
                          <MonoTag key={d}>{d}</MonoTag>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}
