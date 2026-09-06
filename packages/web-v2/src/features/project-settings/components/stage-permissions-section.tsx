"use client";

// Project settings → Pipeline → "Stage permissions".
//
// Reads and writes states[*].allowedTools / disallowedTools / mcpServers, the
// tool policy the dispatcher hands each session and which was API-only until
// ISS-814. Runner pools (`deviceIds`) are displayed here but edited in
// RunnerPoolsSection, which owns the stage × runner matrix.
//
// Takes the already-fetched pipelineConfig rather than querying, so it never
// flickers mid-edit. Collapsed by default per stage: the only way a denylist
// this long stays legible on one screen.

import { useState } from "react";
import { Badge, Banner, Button, Checkbox, Collapsible, MonoTag } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import {
  denylistBaseline,
  groupByServer,
  humanizeToolName,
  knownToolIds,
  MCP_CATALOG,
  MCP_CATALOG_NAMES,
  PIPELINE_STATUS_ROWS,
  pipelineStatusLabel,
  summarizeStageConfig,
  withStagePatch,
  type PipelineConfig,
  type PipelineStateConfig,
  type StagePermissionRow,
} from "../types";
import { ToolListEditor } from "./tool-list-editor";

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

/** The stages an editor offers: every ladder status, so a stage with no
 *  override yet can be given one, plus any extra status already stored. */
function editableRows(config: PipelineConfig): StagePermissionRow[] {
  const states = (config.states ?? {}) as Record<string, PipelineStateConfig | undefined>;
  const rows = PIPELINE_STATUS_ROWS.map(({ status, label }) => ({
    status,
    label,
    config: states[status] ?? {},
  }));
  const seen = new Set(rows.map((r) => r.status));
  for (const [status, sc] of Object.entries(states)) {
    if (!seen.has(status)) rows.push({ status, label: pipelineStatusLabel(status), config: sc ?? {} });
  }
  return rows;
}

// cm:guard this is the editor's React key, and it must change whenever the STORED stage does: `useState` initialisers do not re-run, so an identity key leaves the form showing pre-save values after a successful write.
function stageEditorKey(config: PipelineStateConfig): string {
  return JSON.stringify(config);
}

function StageEditor({
  projectId,
  config,
  status,
}: {
  projectId: string;
  config: PipelineConfig;
  status: string;
}) {
  const update = useUpdatePipelineConfig(projectId);
  const stored = ((config.states ?? {}) as Record<string, PipelineStateConfig | undefined>)[status] ?? {};

  const [denied, setDenied] = useState<string[]>(stored.disallowedTools ?? []);
  const [allowed, setAllowed] = useState<string[]>(stored.allowedTools ?? []);
  const [mcp, setMcp] = useState<Record<string, unknown>>(stored.mcpServers ?? {});

  const snapshot = (d: string[], a: string[], m: Record<string, unknown>) =>
    JSON.stringify([[...d], [...a], Object.keys(m).sort().map((k) => [k, m[k]])]);
  const dirty =
    snapshot(denied, allowed, mcp) !==
    snapshot(stored.disallowedTools ?? [], stored.allowedTools ?? [], stored.mcpServers ?? {});

  // cm:guard an EMPTY list is `undefined`, never `[]`: `stageConfigSchema` accepts both, but a stored `disallowedTools: []` reads on every later screen as "this stage was deliberately given an empty denylist" rather than "this stage has no override", which is the distinction `summarizeStageConfig` renders.
  function save() {
    const patch: PipelineStateConfig = {
      disallowedTools: denied.length > 0 ? denied : undefined,
      allowedTools: allowed.length > 0 ? allowed : undefined,
      mcpServers: Object.keys(mcp).length > 0 ? mcp : undefined,
    };
    update.mutate(withStagePatch(config, status, patch));
  }

  return (
    <div className="mt-3 space-y-4 border-t border-line pt-3">
      <ToolListEditor
        label="Denied tools"
        hint="A real denylist — the tool is removed from the session's set even under bypassPermissions, and deny wins over allow."
        value={denied}
        options={knownToolIds(config)}
        onChange={setDenied}
      />

      <ToolListEditor
        label="Allowed tools (allowlist)"
        hint="Empty means every tool not denied above. Listing any narrows the session to exactly these."
        value={allowed}
        options={knownToolIds(config)}
        onChange={setAllowed}
      />

      <div>
        <p className="fg-caption mb-1 text-muted">
          MCP servers — layered on top of the project default for this stage only
        </p>
        <div className="space-y-1.5">
          {MCP_CATALOG_NAMES.map((name) => (
            <Checkbox
              key={name}
              checked={mcp[name] === true}
              onChange={(on) =>
                setMcp((m) => {
                  const next = { ...m };
                  if (on) next[name] = true;
                  else delete next[name];
                  return next;
                })
              }
              label={`${MCP_CATALOG[name].label} — ${MCP_CATALOG[name].hint}`}
            />
          ))}
          {Object.keys(mcp)
            .filter((n) => !MCP_CATALOG_NAMES.includes(n))
            .map((n) => (
              <div key={n} className="flex items-center justify-between gap-3">
                <MonoTag>{n}</MonoTag>
                <Button variant="ghost" size="sm" onClick={() => setMcp((m) => {
                  const next = { ...m };
                  delete next[n];
                  return next;
                })}>
                  Remove
                </Button>
              </div>
            ))}
        </div>
        <p className="fg-caption mt-1 text-subtle">
          A custom server spec is written through the API — this list edits the catalog entries.
        </p>
      </div>

      {update.isError && (
        <Banner tone="danger" onDismiss={() => update.reset()}>
          {formatPipelineConfigError(update.error)}
        </Banner>
      )}

      <Button
        variant="primary"
        loading={update.isPending}
        disabled={!dirty}
        onClick={save}
        className="min-h-11"
      >
        Save {pipelineStatusLabel(status)} permissions
      </Button>
    </div>
  );
}

export function StagePermissionsSection({
  projectId,
  config,
  canEdit,
  deviceNames,
}: {
  projectId: string;
  config: PipelineConfig;
  canEdit: boolean;
  /** deviceId → runner name, so a pinned pool reads as boxes, not UUIDs. Optional: the component stays query-free. */
  deviceNames?: Record<string, string>;
}) {
  const rows = canEdit ? editableRows(config) : summarizeStageConfig(config);
  const diffs = denylistBaseline(summarizeStageConfig(config));
  const diffByStatus = new Map(diffs.map((d) => [d.status, d]));

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Stage permissions</h3>
      <p className="fg-body-sm mb-3 text-muted">
        What each stage&apos;s agent may and may not reach, and the MCP servers layered on for that
        stage alone. Runner pools are shown here and edited in the matrix below.
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
                    {pool.length > 0 && (
                      <Badge>{pool.length === 1 ? "1 pinned runner" : `${pool.length} runner pool`}</Badge>
                    )}
                    {diff?.isOutlier && <Badge tone="amber">Differs from the other stages</Badge>}
                  </div>
                }
              >
                <div className="space-y-3">
                  {!canEdit && denied.length > 0 && (
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

                  {!canEdit && allowed.length > 0 && (
                    <div>
                      <p className="fg-caption mb-1 text-muted">Allowed tools (allowlist)</p>
                      <ToolChips tools={allowed} />
                    </div>
                  )}

                  {!canEdit && mcpNames.length > 0 && (
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

                  {pool.length > 0 && (
                    <div>
                      <p className="fg-caption mb-1 text-muted">
                        Runner pool — this stage only runs on these devices. When all of them are
                        busy or limited, its jobs wait instead of moving to another runner.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {pool.map((d) => (
                          <MonoTag key={d}>{deviceNames?.[d] ?? d}</MonoTag>
                        ))}
                      </div>
                    </div>
                  )}

                  {canEdit && (
                    <StageEditor
                      key={stageEditorKey(row.config)}
                      projectId={projectId}
                      config={config}
                      status={row.status}
                    />
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
