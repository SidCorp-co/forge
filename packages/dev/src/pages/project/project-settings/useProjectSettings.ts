import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { useAuth } from "@/hooks/useAuth";
import { invoke } from "@/hooks/use-tauri-ipc";
import { getProject } from "@/lib/api";
import type { AppConfig, McpServerConfig } from "@/lib/types";

export function useProjectSettings() {
  const { slug } = useParams<{ slug: string }>();
  const auth = useAuth();
  const deviceSettings = useAppStore((s) => s.deviceSettings);
  const patchDeviceSettings = useAppStore((s) => s.patchDeviceSettings);
  const projectConfig = slug ? deviceSettings.projects[slug] : undefined;

  const [repoPath, setRepoPath] = useState(projectConfig?.repoPath ?? "");
  const [branch, setBranch] = useState(projectConfig?.branch ?? "main");
  const [instructions, setInstructions] = useState(projectConfig?.instructions ?? "");
  const documentId = projectConfig?.documentId;
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveLog, setSaveLog] = useState<Array<{ step: string; status: "ok" | "error" | "skip"; detail?: string }>>([]);
  // Listen for project init log events (from web-initiated agent starts)
  useEffect(() => {
    if (!slug) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const ul = await listen<{ projectSlug: string; step: string; status: "ok" | "error" | "skip"; detail?: string }>(
          "project:init-log",
          (event) => {
            if (cancelled || event.payload.projectSlug !== slug) return;
            setSaveLog((prev) => [...prev, event.payload]);
          },
        );
        if (cancelled) { ul(); return; }
        unlisten = ul;
      } catch {}
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [slug]);

  // Sync repoPath and branch from server project on load
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const project = await getProject(slug);
        if (cancelled || !project) return;
        if (project.repoPath && !projectConfig?.repoPath) setRepoPath(project.repoPath);
        if (project.baseBranch) setBranch(project.baseBranch);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [slug]);

  function ensureForgeMcp(servers: Record<string, McpServerConfig>, deviceToken: string | null, sentryProject?: string): Record<string, McpServerConfig> {
    const existing = servers["forge"];
    const headers: Record<string, string> = {};
    if (deviceToken) {
      // packages/core /mcp is gated by requireDevice() — only accepts
      // `Authorization: Bearer <device-token>`. The legacy `X-Forge-API-Key`
      // path was removed in ISS-202; sending the project apiKey here causes
      // 401 → Claude CLI MCP SDK falls back to OAuth dynamic-client
      // registration → 404 on POST /register.
      headers["Authorization"] = `Bearer ${deviceToken}`;
    }
    headers["X-Forge-Project-Slug"] = slug ?? "";
    if (sentryProject) {
      headers["X-Sentry-Project"] = sentryProject;
    }
    return {
      ...servers,
      forge: {
        type: "http",
        url: `${auth.coreUrl ?? ""}/mcp`,
        headers,
        enabled: existing?.enabled ?? true,
      },
    };
  }

  async function handleSave() {
    if (!slug) return;
    setSaving(true);
    setSaveLog([]);
    const log: typeof saveLog = [];
    const addLog = (step: string, status: "ok" | "error" | "skip", detail?: string) => {
      log.push({ step, status, detail });
      setSaveLog([...log]);
    };

    // Validate repo path
    if (repoPath) {
      try {
        await invoke("ensure_directory", { path: repoPath });
        addLog("Validate repo path", "ok", repoPath);
      } catch (err) {
        addLog("Validate repo path", "error", `Cannot access ${repoPath}: ${err}`);
        setSaving(false);
        return;
      }
    } else {
      addLog("Validate repo path", "skip", "No path set");
    }

    // Load the device token from the OS keychain — it's the only accepted
    // credential for the Forge MCP /mcp endpoint (ISS-202).
    let deviceToken: string | null = null;
    try {
      deviceToken = await invoke<string | null>("load_device_token");
      addLog("Load device token", deviceToken ? "ok" : "skip", deviceToken ? undefined : "device not paired");
    } catch (err) {
      addLog("Load device token", "error", String(err));
    }

    // Fetch project for Sentry-Project header (no longer for apiKey — see
    // ensureForgeMcp comment) and persist documentId so the runner can register
    // for this project (ISS-173).
    let sentryProject: string | undefined;
    let persistedDocumentId: string | undefined = projectConfig?.documentId;
    try {
      const project = await getProject(slug);
      sentryProject = project?.sentryProject;
      if (project?.documentId) persistedDocumentId = project.documentId;
      addLog("Fetch project config", "ok", sentryProject ? `Sentry: ${sentryProject}` : "no Sentry project");
    } catch (err) {
      addLog("Fetch project config", "error", String(err));
    }

    // Auto-detect MCP from repo + ensure Forge MCP
    let mcpServers = projectConfig?.mcpServers ?? {};
    if (repoPath) {
      try {
        const detected = (await invoke("detect_mcp_servers", { repoPath })) as Record<string, McpServerConfig>;
        if (detected && Object.keys(detected).length > 0) {
          mcpServers = { ...detected, ...mcpServers };
          addLog("Detect MCP servers", "ok", `${Object.keys(detected).length} found`);
        } else {
          addLog("Detect MCP servers", "ok", "None found");
        }
      } catch (err) {
        addLog("Detect MCP servers", "error", String(err));
      }
    }
    mcpServers = ensureForgeMcp(mcpServers, deviceToken, sentryProject);

    // Save local config
    try {
      const nextProjects = {
        ...deviceSettings.projects,
        [slug]: {
          slug,
          repoPath,
          branch,
          instructions,
          mcpServers,
          ...(persistedDocumentId ? { documentId: persistedDocumentId } : {}),
        },
      };
      patchDeviceSettings({ projects: nextProjects });
      // Round-trip through the disk snapshot so save_config carries the auth
      // fields the Rust IPC expects. Auth fields are owned by auth-store and
      // already on disk — re-reading is the simplest way to avoid drift.
      const disk = (await invoke("get_config")) as AppConfig;
      await invoke("save_config", { config: { ...disk, projects: nextProjects } });
      addLog("Save local config", "ok");
    } catch (err) {
      addLog("Save local config", "error", String(err));
      setSaving(false);
      return;
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return {
    slug,
    documentId,
    repoPath,
    setRepoPath,
    branch,
    setBranch,
    instructions,
    setInstructions,
    saved,
    saving,
    saveLog,
    handleSave,
  };
}
