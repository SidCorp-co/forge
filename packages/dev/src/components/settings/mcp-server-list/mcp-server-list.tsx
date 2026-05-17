import { useEffect, useMemo, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { invoke } from "@/hooks/use-tauri-ipc";
import { useAuth } from "@/hooks/useAuth";
import { McpServerEditor } from "@/components/settings/mcp-server-editor";
import { McpConnectionStatus } from "@/components/settings/mcp-connection-status";
import { McpServerWizard } from "@/components/settings/mcp-server-wizard";
import { Button, EmptyState } from "@/components/ui";
import { ForgeServerRow, LibraryServerRow, ProjectServerRow } from "./mcp-server-row";

interface McpServerListProps {
  servers: Record<string, McpServerConfig>;
  onChange: (servers: Record<string, McpServerConfig>) => void;
  repoPath?: string;
  projectSlug?: string;
  sentryProject?: string;
  libraryServers?: Record<string, McpServerConfig>;
  enabledLibraryServers?: string[];
  onLibraryToggle?: (name: string, enabled: boolean) => void;
  onLibraryRemove?: (name: string) => void;
  onPasteAdd?: (servers: Record<string, McpServerConfig>) => void;
}

interface SectionCollapseState {
  forge: boolean;
  library: boolean;
  project: boolean;
}

interface SectionHeaderProps {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

function SectionHeader({ title, count, collapsed, onToggle }: SectionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center justify-between rounded px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50"
    >
      <span>
        {title} <span className="text-gray-400">({count})</span>
      </span>
      <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
    </button>
  );
}

export function McpServerList({
  servers,
  onChange,
  repoPath,
  projectSlug,
  sentryProject,
  libraryServers = {},
  enabledLibraryServers = [],
  onLibraryToggle,
  onLibraryRemove,
  onPasteAdd,
}: McpServerListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<SectionCollapseState>({
    forge: false,
    library: false,
    project: false,
  });
  const auth = useAuth();

  useEffect(() => {
    invoke<string | null>("load_device_token")
      .then(setDeviceToken)
      .catch(() => setDeviceToken(null));
  }, []);

  const forgeServer: McpServerConfig | null = useMemo(() => {
    if (!auth.coreUrl) return null;
    return {
      type: "http",
      url: `${auth.coreUrl}/mcp`,
      headers: {
        ...(deviceToken ? { Authorization: `Bearer ${deviceToken}` } : {}),
        ...(projectSlug ? { "X-Forge-Project-Slug": projectSlug } : {}),
        ...(sentryProject ? { "X-Sentry-Project": sentryProject } : {}),
      },
      enabled: true,
    };
  }, [auth.coreUrl, deviceToken, projectSlug, sentryProject]);

  function handleToggle(name: string) {
    const updated = { ...servers };
    updated[name] = { ...updated[name], enabled: !(updated[name].enabled ?? true) };
    onChange(updated);
  }

  function handleRemove(name: string) {
    const updated = { ...servers };
    delete updated[name];
    onChange(updated);
  }

  function handleSave(name: string, cfg: McpServerConfig) {
    const updated = { ...servers };
    if (editing && editing !== name) delete updated[editing];
    updated[name] = cfg;
    onChange(updated);
    setEditing(null);
  }

  function handleManualAdd(name: string, cfg: McpServerConfig) {
    onChange({ ...servers, [name]: cfg });
  }

  const projectEntries = Object.entries(servers);
  const libraryEntries = Object.entries(libraryServers);
  const hasEntries =
    projectEntries.length > 0 || libraryEntries.length > 0 || !!forgeServer;

  const sharedRowMeta = {
    deviceToken,
    projectSlug,
    sentryProject,
    repoPath: repoPath ?? "",
  };

  return (
    <div className="space-y-4">
      <McpConnectionStatus
        coreUrl={auth.coreUrl}
        projectSlug={projectSlug}
        sentryProject={sentryProject}
        deviceToken={deviceToken}
        forgeServer={forgeServer}
      />

      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-gray-600">MCP servers</label>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setWizardOpen(true)}>
            + Add MCP server
          </Button>
        </div>
      </div>

      {forgeServer && (
        <section className="space-y-2">
          <SectionHeader
            title="Forge (built-in)"
            count={1}
            collapsed={collapsed.forge}
            onToggle={() => setCollapsed((s) => ({ ...s, forge: !s.forge }))}
          />
          {!collapsed.forge && (
            <ForgeServerRow name="forge" server={forgeServer} {...sharedRowMeta} />
          )}
        </section>
      )}

      {libraryEntries.length > 0 && (
        <section className="space-y-2">
          <SectionHeader
            title="Library"
            count={libraryEntries.length}
            collapsed={collapsed.library}
            onToggle={() => setCollapsed((s) => ({ ...s, library: !s.library }))}
          />
          {!collapsed.library &&
            libraryEntries.map(([name, server]) => (
              <LibraryServerRow
                key={`lib-${name}`}
                name={name}
                server={server}
                enabled={enabledLibraryServers.includes(name)}
                onToggle={(enabled) => onLibraryToggle?.(name, enabled)}
                onRemove={() => onLibraryRemove?.(name)}
                {...sharedRowMeta}
              />
            ))}
        </section>
      )}

      {projectEntries.length > 0 && (
        <section className="space-y-2">
          <SectionHeader
            title={`Project (${projectSlug ?? "—"})`}
            count={projectEntries.length}
            collapsed={collapsed.project}
            onToggle={() => setCollapsed((s) => ({ ...s, project: !s.project }))}
          />
          {!collapsed.project &&
            projectEntries.map(([name, server]) =>
              editing === name ? (
                <McpServerEditor
                  key={name}
                  name={name}
                  server={server}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <ProjectServerRow
                  key={name}
                  name={name}
                  server={server}
                  onToggle={() => handleToggle(name)}
                  onEdit={() => setEditing(name)}
                  onRemove={() => handleRemove(name)}
                  {...sharedRowMeta}
                />
              ),
            )}
        </section>
      )}

      {!hasEntries && (
        <EmptyState
          icon={
            <svg
              className="mx-auto h-8 w-8 text-gray-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0h.375a2.625 2.625 0 010 5.25H3.375a2.625 2.625 0 010-5.25H3.75"
              />
            </svg>
          }
          title="No MCP servers configured"
          description="The built-in Forge server appears here when this device is paired. Add servers via the wizard."
          action={
            <Button variant="secondary" size="sm" onClick={() => setWizardOpen(true)}>
              + Add MCP server
            </Button>
          }
        />
      )}

      <McpServerWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onPasteAdd={(servers) => {
          onPasteAdd?.(servers);
        }}
        onManualAdd={handleManualAdd}
        libraryServers={libraryServers}
        enabledLibraryServers={enabledLibraryServers}
        onLibraryToggle={onLibraryToggle}
        coreUrl={auth.coreUrl}
        projectSlug={projectSlug}
      />
    </div>
  );
}
