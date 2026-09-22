"use client";


import { useEffect, useMemo, useState } from "react";
import {
  Button,
  CardTitle,
  Icon,
  Input,
  Textarea,
  Toggle,
} from "@/design";
import { useUpdatePipelineConfig } from "../hooks";
import { providerForMcpServerName } from "@/features/integrations/providers/registry";
import {
  MCP_CATALOG,
  MCP_CATALOG_NAMES,
  type PipelineConfig,
  sectionWrite,
} from "../types";
import { SaveRefusedBanner } from "./save-refused-banner";

type ServerMap = Record<string, unknown>;

/** True when a stored entry should render the catalog toggle as ON. */
function isCatalogEnabled(value: unknown): boolean {
  return value === true;
}

/** Custom (non-catalog) entries: name → pretty-printed JSON spec. */
function customEntries(map: ServerMap): Array<{ name: string; value: unknown }> {
  return Object.entries(map)
    .filter(([name, value]) => {
      if (MCP_CATALOG_NAMES.includes(name)) return value !== true && value != null && value !== false;
      return value != null && value !== false;
    })
    .map(([name, value]) => ({ name, value }));
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
    const integration = providerForMcpServerName(name);
    if (integration) {
      setCustomError(
        `${name} is the ${integration.label} integration, not a custom server. Whether agents on this project may use it is set on the Integrations tab, on that integration's own row — adding the name here injects nothing.`,
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
    update.mutate(sectionWrite({ mcpServers: config.mcpServers }, { mcpServers: draft }));
  }

  const custom = customEntries(draft);

  return (
    <div className="mt-6 border-t border-line pt-5">
      <CardTitle className="fg-label text-fg">MCP servers (project default)</CardTitle>
      <p className="fg-body-sm mb-3 text-muted">
        Servers seeded into every agent dispatched for this project. Required because the runner
        ignores its own MCP config — declare the secret-free servers your jobs need here. Per-stage
        overrides layer on top. Connected integrations are not set here: whether an agent may use one
        is granted on that integration&apos;s own row, under the Integrations tab.
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

        {custom.map(({ name, value }) => (
          <div key={name} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="fg-label flex flex-wrap items-center gap-1.5 text-fg">
                <Icon name="command" size={13} className="text-muted" />
                <span className="font-mono text-13">{name}</span>
                {providerForMcpServerName(name) ? (
                  <span className="fg-body-sm rounded-pill bg-[var(--amberw-50)] px-2 py-0.5 text-[var(--amberw-700)]">
                    {providerForMcpServerName(name)?.label} integration — injects nothing from here
                  </span>
                ) : (
                  <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    custom
                  </span>
                )}
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
                // The example must be a name this form would ACCEPT. It read `sentry` until
                // ISS-1071, which is a provider name the refusal below rejects by name — so the
                // field's own worked example was a value typing it verbatim could not use.
                placeholder="Server name (e.g. internal-docs)"
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
                className="font-mono text-12-5"
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
            <SaveRefusedBanner
              projectId={projectId}
              error={update.error}
              onDismiss={() => update.reset()}
            />
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
