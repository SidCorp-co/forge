"use client";

// Project settings → Pipeline → "MCP servers" (project-default).
//
// Edits `pipelineConfig.mcpServers`, the project-default MCP server set the
// dispatcher seeds into EVERY job's temp `--mcp-config`. forge-runner's
// `--strict-mcp-config` makes Claude ignore the runner box's own MCP config,
// so a project must declare the secret-free servers it wants (playwright, …)
// here. The dispatcher merges this as the BASE; per-state overrides layer on
// top.
//
// ISS-1038 — this map ALSO stores the integration sentinels
// (postman/epodsystem/sentry), and this section no longer pretends otherwise
// and no longer edits them. It used to say connected integrations "layer on
// top", which read as: connect one and it arrives. It does not — the sentinel
// is what makes the dispatcher inject it, this screen could not write one
// (`addCustom` takes a JSON object and the sentinel's only legal value is
// `true`), and a stored one rendered here as a custom server whose spec
// printed as `true`. So: they render as what they are, read-only, naming the
// Integrations tab where their switch actually is.
//
// Shorthand persisted to `mcpServers`:
//   - `name: true`            → enable a catalog default (MCP_CATALOG)
//   - `{ …raw spec }`         → a custom server (stdio command/args/env, or
//                               http url/headers), used verbatim by the runner
//   - absent                  → omitted
//
// Round-trips the FULL fetched pipelineConfig on save (the PATCH schema
// requires `states`), only overriding the `mcpServers` key — sibling keys the
// Pipeline tab owns survive.

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, Input, Textarea, Toggle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import {
  integrationServerLabel,
  isIntegrationServerName,
  MCP_CATALOG,
  MCP_CATALOG_NAMES,
  type PipelineConfig,
} from "../types";

type ServerMap = Record<string, unknown>;

/** True when a stored entry should render the catalog toggle as ON. */
function isCatalogEnabled(value: unknown): boolean {
  return value === true;
}

/** Custom (non-catalog, non-integration) entries: name → raw JSON spec.
 *  ISS-1038 — an integration sentinel used to fall through here and render as a
 *  custom server. It is split out by `integrationEntries` below instead. */
function customEntries(map: ServerMap): Array<{ name: string; value: unknown }> {
  return Object.entries(map)
    .filter(([name, value]) => {
      if (isIntegrationServerName(name)) return false;
      if (MCP_CATALOG_NAMES.includes(name)) return value !== true && value != null && value !== false;
      return value != null && value !== false;
    })
    .map(([name, value]) => ({ name, value }));
}

/** Integration sentinels stored in this map. Read-only here. ISS-1038. */
function integrationEntries(map: ServerMap): string[] {
  return Object.entries(map)
    .filter(([name, value]) => isIntegrationServerName(name) && value !== false && value != null)
    .map(([name]) => name);
}

export function McpServersSection({
  projectId,
  config,
  canEdit,
}: {
  projectId: string;
  /** The full server-fetched pipelineConfig (round-tripped on save). */
  config: PipelineConfig;
  canEdit: boolean;
}) {
  const update = useUpdatePipelineConfig(projectId);

  const serverMap = useMemo<ServerMap>(() => {
    const m = config.mcpServers;
    return m && typeof m === "object" ? (m as ServerMap) : {};
  }, [config.mcpServers]);

  // Local working copy of the map; reset whenever the server config changes.
  const [draft, setDraft] = useState<ServerMap>(serverMap);
  useEffect(() => {
    setDraft(serverMap);
  }, [serverMap]);

  // "Add custom server" form state.
  const [addOpen, setAddOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customSpec, setCustomSpec] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(serverMap);

  function toggleCatalog(name: string, on: boolean) {
    setDraft((d) => {
      const next = { ...d };
      if (on) next[name] = true;
      else delete next[name];
      return next;
    });
  }

  function removeServer(name: string) {
    setDraft((d) => {
      const next = { ...d };
      delete next[name];
      return next;
    });
  }

  function addCustom() {
    setCustomError(null);
    const name = customName.trim();
    if (!name) {
      setCustomError("Name is required.");
      return;
    }
    // Refuse the NAME, not the value's shape. An operator typing `epodsystem`
    // here is reaching for the switch this section used to hide; telling them
    // "Spec must be a JSON object" sends them away to write a spec that would
    // not inject anything. ISS-1038.
    if (isIntegrationServerName(name)) {
      setCustomError(
        `“${name}” is a connected integration, not a custom server. Turn it on under Settings → Integrations → Agent MCP servers; its credential is attached at dispatch and never stored here.`,
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(customSpec);
    } catch {
      setCustomError("Spec must be valid JSON.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setCustomError("Spec must be a JSON object (e.g. { \"type\": \"stdio\", … }).");
      return;
    }
    setDraft((d) => ({ ...d, [name]: parsed }));
    setCustomName("");
    setCustomSpec("");
    setAddOpen(false);
  }

  function save() {
    // Round-trip the full config; only override mcpServers.
    const next: PipelineConfig = { ...config, mcpServers: draft };
    update.mutate(next);
  }

  const custom = customEntries(draft);
  // Rendered, never edited here — but they stay in `draft`, so Save round-trips
  // them exactly as stored. ISS-1038.
  const integrations = integrationEntries(draft);

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">MCP servers (project default)</h3>
      <p className="fg-body-sm mb-3 text-muted">
        Servers seeded into every agent dispatched for this project. Required because the runner
        ignores its own MCP config — declare the secret-free servers your jobs need here. Per-stage
        overrides layer on top. Connected integrations are switched on Settings → Integrations, not
        here.
      </p>

      <div className="divide-y divide-line">
        {MCP_CATALOG_NAMES.map((name) => {
          const meta = MCP_CATALOG[name];
          return (
            <div key={name} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="fg-label text-fg">{meta.label}</p>
                <p className="fg-caption text-muted">{meta.hint}</p>
              </div>
              <Toggle
                checked={isCatalogEnabled(draft[name])}
                onChange={(v) => toggleCatalog(name, v)}
                disabled={!canEdit}
                aria-label={meta.label}
              />
            </div>
          );
        })}

        {integrations.length > 0 && (
          <div className="py-2.5">
            <p className="fg-label text-fg">Connected integrations</p>
            <p className="fg-caption mb-2 text-muted">
              Declared here, switched on Settings → Integrations → Agent MCP servers. The
              credential is attached at dispatch time and is never part of this map.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {integrations.map((name) => (
                <span
                  key={name}
                  className="fg-caption flex items-center gap-1.5 rounded-pill border border-line px-2 py-0.5 text-muted"
                >
                  <Icon name="command" size={12} />
                  <span className="font-mono">{name}</span>
                  <span className="text-subtle">
                    {integrationServerLabel(name)}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {custom.map(({ name, value }) => (
          <div key={name} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="fg-label flex items-center gap-1.5 text-fg">
                <Icon name="command" size={13} className="text-muted" />
                <span className="font-mono text-[13px]">{name}</span>
                <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                  custom
                </span>
              </p>
              <pre className="fg-caption mt-1 max-w-full overflow-x-auto rounded-md bg-sunken px-2 py-1 font-mono text-muted">
                {JSON.stringify(value)}
              </pre>
            </div>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={() => removeServer(name)}>
                Remove
              </Button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="mt-3 space-y-3">
          {addOpen ? (
            <div className="space-y-2 rounded-md border border-line bg-surface p-3">
              <Input
                placeholder="Server name (e.g. sentry)"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
              <Textarea
                placeholder={
                  'Raw MCP spec JSON, e.g.\n{ "type": "stdio", "command": "npx", "args": ["@scope/mcp"], "env": {} }\nor\n{ "type": "http", "url": "https://…", "headers": {} }'
                }
                rows={5}
                value={customSpec}
                onChange={(e) => setCustomSpec(e.target.value)}
                className="font-mono text-[12.5px]"
              />
              {customError && (
                <p className="fg-caption text-[var(--red-600)]">{customError}</p>
              )}
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={addCustom}>
                  Add server
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAddOpen(false);
                    setCustomError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={14} className="mr-1" />
              Add custom server
            </Button>
          )}

          {update.isError && (
            <Banner tone="danger" onDismiss={() => update.reset()}>
              {formatApiError(update.error)}
            </Banner>
          )}

          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty}
            onClick={save}
            className="min-h-11"
          >
            Save MCP servers
          </Button>
        </div>
      )}
    </div>
  );
}
