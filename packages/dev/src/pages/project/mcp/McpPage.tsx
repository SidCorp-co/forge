import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { McpServerList } from "@/components/settings/mcp-server-list";
import { McpPasteParser } from "@/components/settings/mcp-paste-parser";
import { PageShell } from "@/components/ui/page-shell";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "@/hooks/use-tauri-ipc";
import { getProject } from "@/lib/api";
import type { AppConfig, McpServerConfig } from "@/lib/types";

export function McpPage() {
  const { slug } = useParams<{ slug: string }>();
  const deviceSettings = useAppStore((s) => s.deviceSettings);
  const setDeviceSettings = useAppStore((s) => s.setDeviceSettings);
  const patchDeviceSettings = useAppStore((s) => s.patchDeviceSettings);
  const projectConfig = slug ? deviceSettings.projects[slug] : undefined;
  const mcpServers = projectConfig?.mcpServers ?? {};
  const mcpLibrary = deviceSettings.mcpLibrary ?? {};
  const enabledMcpServers = projectConfig?.enabledMcpServers ?? [];
  const [sentryProject, setSentryProject] = useState<string | undefined>();

  useEffect(() => {
    if (!slug) return;
    getProject(slug).then((p) => {
      setSentryProject(p?.sentryProject);
    }).catch(() => {});
  }, [slug]);

  const [showPaste, setShowPaste] = useState(false);

  async function reloadConfig() {
    // Disk shape carries auth fields — but the renderer's deviceSettings
    // slice only mirrors the device-side fields. Refresh those from disk.
    const updated = (await invoke("get_config")) as AppConfig;
    setDeviceSettings({
      projects: updated.projects ?? {},
      projectsRoot: updated.projectsRoot,
      skillLibrary: updated.skillLibrary,
      mcpLibrary: updated.mcpLibrary,
    });
  }

  async function handleChange(servers: Record<string, McpServerConfig>) {
    if (!slug || !projectConfig) return;
    const nextProjects = {
      ...deviceSettings.projects,
      [slug]: { ...projectConfig, mcpServers: servers },
    };
    patchDeviceSettings({ projects: nextProjects });
    // Round-trip via disk so save_config carries the full shape (Rust IPC
    // contract). Auth fields come from the latest disk snapshot — do NOT
    // reach into auth-store here; this code path runs inside <RequireAuth>
    // so the disk copy is always current.
    const disk = (await invoke("get_config")) as AppConfig;
    await invoke("save_config", {
      config: { ...disk, projects: nextProjects },
    });
  }

  async function handleLibraryToggle(name: string, enabled: boolean) {
    if (!slug || !projectConfig) return;
    await invoke("toggle_mcp", { projectSlug: slug, name, enabled });
    await reloadConfig();
  }

  async function handlePasteAdd(servers: Record<string, McpServerConfig>) {
    for (const [name, cfg] of Object.entries(servers)) {
      await invoke("add_library_mcp", { name, mcpConfig: cfg });
      if (slug) {
        await invoke("toggle_mcp", { projectSlug: slug, name, enabled: true });
      }
    }
    await reloadConfig();
    setShowPaste(false);
  }

  async function handleLibraryRemove(name: string) {
    if (slug && enabledMcpServers.includes(name)) {
      await invoke("toggle_mcp", { projectSlug: slug, name, enabled: false });
    }
    await invoke("remove_library_mcp", { name });
    await reloadConfig();
  }

  return (
    <PageShell title="MCP Servers" subtitle={`Model Context Protocol servers for ${slug}`}>
      <div className="space-y-4">
        <McpServerList
          servers={mcpServers}
          onChange={handleChange}
          repoPath={projectConfig?.repoPath}
          projectSlug={slug}
          sentryProject={sentryProject}
          libraryServers={mcpLibrary}
          enabledLibraryServers={enabledMcpServers}
          onLibraryToggle={handleLibraryToggle}
          onLibraryRemove={handleLibraryRemove}
          onShowPaste={() => setShowPaste(true)}
        />

        {showPaste && (
          <McpPasteParser onAdd={handlePasteAdd} onCancel={() => setShowPaste(false)} />
        )}
      </div>
    </PageShell>
  );
}
