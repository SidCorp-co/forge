import { useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { invoke } from "@/hooks/use-tauri-ipc";
import { useAppStore } from "@/stores/app-store";
import { McpServerEditor } from "@/components/settings/mcp-server-editor";
import { Button, EmptyState } from "@/components/ui";
import { ForgeServerRow, LibraryServerRow, ProjectServerRow } from "./mcp-server-row";

interface McpServerListProps {
  servers: Record<string, McpServerConfig>;
  onChange: (servers: Record<string, McpServerConfig>) => void;
  repoPath?: string;
  projectSlug?: string;
  projectApiKey?: string;
  sentryProject?: string;
  libraryServers?: Record<string, McpServerConfig>;
  enabledLibraryServers?: string[];
  onLibraryToggle?: (name: string, enabled: boolean) => void;
  onLibraryRemove?: (name: string) => void;
  onShowPaste?: () => void;
}

export function McpServerList({
  servers,
  onChange,
  repoPath,
  projectSlug,
  projectApiKey,
  sentryProject,
  libraryServers = {},
  enabledLibraryServers = [],
  onLibraryToggle,
  onLibraryRemove,
  onShowPaste,
}: McpServerListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [installedCli, setInstalledCli] = useState<Record<string, "ok" | "err">>({});
  const { config } = useAppStore();

  const forgeServer: McpServerConfig | null = config.strapiUrl
    ? {
        type: "http",
        url: `${config.strapiUrl}/mcp`,
        headers: {
          ...(projectApiKey ? { "X-Forge-API-Key": projectApiKey } : {}),
          ...(projectSlug ? { "X-Forge-Project-Slug": projectSlug } : {}),
          ...(sentryProject ? { "X-Sentry-Project": sentryProject } : {}),
        },
        enabled: true,
      }
    : null;

  async function handleInstallToCli(name: string, server: McpServerConfig) {
    try {
      await invoke("install_mcp_to_cli", { name, server, repoPath: repoPath ?? "" });
      setInstalledCli((prev) => ({ ...prev, [name]: "ok" }));
    } catch {
      setInstalledCli((prev) => ({ ...prev, [name]: "err" }));
    }
  }

  async function handleInstallAll() {
    if (forgeServer) await handleInstallToCli("forge", forgeServer);
    for (const [name, server] of Object.entries(servers)) {
      await handleInstallToCli(name, server);
    }
    for (const name of enabledLibraryServers) {
      if (libraryServers[name]) await handleInstallToCli(name, libraryServers[name]);
    }
  }

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
    setAdding(false);
  }

  const entries = Object.entries(servers);
  const libraryEntries = Object.entries(libraryServers);
  const hasEntries = entries.length > 0 || libraryEntries.length > 0 || forgeServer;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-gray-600">MCP Servers</label>
        <div className="flex gap-2">
          {hasEntries && (
            <Button variant="secondary" size="sm" onClick={handleInstallAll}>
              Install All to CLI
            </Button>
          )}
          {onShowPaste && (
            <Button variant="secondary" size="sm" onClick={onShowPaste}>
              Paste Config
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
            Add Server
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {forgeServer && (
          <ForgeServerRow
            server={forgeServer}
            installStatus={installedCli.forge}
            onInstall={() => handleInstallToCli("forge", forgeServer)}
          />
        )}

        {libraryEntries.length > 0 && (
          <>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">
              Global Library
            </p>
            {libraryEntries.map(([name, server]) => (
              <LibraryServerRow
                key={`lib-${name}`}
                name={name}
                server={server}
                enabled={enabledLibraryServers.includes(name)}
                installStatus={installedCli[name]}
                onToggle={(enabled) => onLibraryToggle?.(name, enabled)}
                onInstall={() => handleInstallToCli(name, server)}
                onRemove={() => onLibraryRemove?.(name)}
              />
            ))}
          </>
        )}

        {entries.length > 0 && (
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">
            Project Servers
          </p>
        )}
        {entries.map(([name, server]) =>
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
              installStatus={installedCli[name]}
              onToggle={() => handleToggle(name)}
              onInstall={() => handleInstallToCli(name, server)}
              onEdit={() => setEditing(name)}
              onRemove={() => handleRemove(name)}
            />
          ),
        )}

        {!hasEntries && !adding && (
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
            description='The built-in Forge server will appear when Strapi is configured. Click "Add Server" or "Paste Config" to add servers.'
          />
        )}

        {adding && (
          <McpServerEditor
            name=""
            server={{ command: "", enabled: true }}
            onSave={handleSave}
            onCancel={() => setAdding(false)}
            isNew
          />
        )}
      </div>
    </div>
  );
}
