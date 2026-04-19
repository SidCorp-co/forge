import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "@/hooks/use-tauri-ipc";
import { getProject, setDeviceProjectPath } from "@/lib/api";
import type { AppConfig, McpServerConfig } from "@/lib/types";

export function useProjectSettings() {
  const { slug } = useParams<{ slug: string }>();
  const { config, setConfig } = useAppStore();
  const projectConfig = slug ? config.projects[slug] : undefined;

  const [repoPath, setRepoPath] = useState(projectConfig?.repoPath ?? "");
  const [branch, setBranch] = useState(projectConfig?.branch ?? "main");
  const [instructions, setInstructions] = useState(projectConfig?.instructions ?? "");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveLog, setSaveLog] = useState<Array<{ step: string; status: "ok" | "error" | "skip"; detail?: string }>>([]);
  const [indexingRepo, setIndexingRepo] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<string | null>(null);
  const indexSessionRef = useRef<string | null>(null);
  const [indexLog, setIndexLog] = useState<string[]>([]);

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

  // Listen for agent events to track indexing progress
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const ul = await listen<{ sessionId: string; data: Record<string, unknown> }>(
          "agent:message",
          (event) => {
            if (cancelled) return;
            const { sessionId, data } = event.payload;
            if (sessionId !== indexSessionRef.current) return;

            // Capture streaming output for log
            if (data.type === "assistant") {
              const msg = data.message as Record<string, unknown> | undefined;
              const content = msg?.content as Array<{ type: string; text?: string; name?: string }> | undefined;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (c.type === "text" && c.text) {
                    setIndexLog((prev) => [...prev, c.text!]);
                  } else if (c.type === "tool_use") {
                    const input = (c as Record<string, unknown>).input as Record<string, unknown> | undefined;
                    let detail = "";
                    if (c.name === "Bash" && input?.command) {
                      detail = ` $ ${String(input.command).slice(0, 120)}`;
                    } else if (c.name === "Read" && input?.file_path) {
                      detail = ` ${input.file_path}`;
                    } else if (c.name === "Write" && input?.file_path) {
                      detail = ` ${input.file_path}`;
                    } else if (c.name === "Edit" && input?.file_path) {
                      detail = ` ${input.file_path}`;
                    } else if (c.name === "Glob" && input?.pattern) {
                      detail = ` ${input.pattern}`;
                    } else if (c.name === "Grep" && input?.pattern) {
                      detail = ` ${input.pattern}`;
                    } else if (input) {
                      detail = ` ${JSON.stringify(input).slice(0, 100)}`;
                    }
                    setIndexLog((prev) => [...prev, `⚡ ${c.name ?? "tool"}${detail}`]);
                  }
                }
              }
            } else if (data.type === "system") {
              const msg = (data.message as string) ?? "";
              if (msg) setIndexLog((prev) => [...prev, msg]);
            }

            if (data.type === "result") {
              const failed = (data.is_error as boolean) ?? false;
              if (failed) {
                setIndexStatus("Indexing failed");
                setIndexingRepo(null);
                indexSessionRef.current = null;
              } else {
                setIndexStatus("Indexing complete!");
                setIndexingRepo(null);
                indexSessionRef.current = null;
                setTimeout(() => setIndexStatus(null), 3000);
              }
            }
          },
        );
        if (cancelled) { ul(); return; }
        unlisten = ul;

        // Also listen for agent:complete to catch errors
        const ul2 = await listen<{ sessionId: string; error?: string }>(
          "agent:complete",
          (event) => {
            if (cancelled) return;
            if (event.payload.sessionId !== indexSessionRef.current) return;
            if (event.payload.error) {
              setIndexLog((prev) => [...prev, `Error: ${event.payload.error}`]);
              setIndexStatus("Indexing failed");
              setIndexingRepo(null);
              indexSessionRef.current = null;
            }
          },
        );
        if (cancelled) { ul2(); return; }
        const origUnlisten = unlisten;
        unlisten = () => { origUnlisten?.(); ul2(); };
      } catch {}
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function handleIndex() {
    if (!slug || !repoPath) return;
    setIndexingRepo(repoPath);
    setIndexStatus("Indexing codebase...");
    setIndexLog([]);
    try {
      const sessionId = await invoke<string>("run_agent", {
        repoPath,
        prompt: `/forge-index ${branch}`,
        projectSlug: slug,
        permissionMode: "bypassPermissions",
      });
      indexSessionRef.current = sessionId;
    } catch (err) {
      setIndexingRepo(null);
      setIndexStatus(`Index failed: ${err}`);
      setTimeout(() => setIndexStatus(null), 3000);
    }
  }

  function ensureForgeMcp(servers: Record<string, McpServerConfig>, projectApiKey?: string, sentryProject?: string): Record<string, McpServerConfig> {
    const existing = servers["forge"];
    const headers: Record<string, string> = {};
    if (projectApiKey) {
      headers["X-Forge-API-Key"] = projectApiKey;
    }
    headers["X-Forge-Project-Slug"] = slug ?? "";
    if (sentryProject) {
      headers["X-Sentry-Project"] = sentryProject;
    }
    return {
      ...servers,
      forge: {
        type: "http",
        url: `${config.strapiUrl}/mcp`,
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

    // Fetch project API key for MCP auth
    let projectApiKey: string | undefined;
    let sentryProject: string | undefined;
    try {
      const project = await getProject(slug);
      projectApiKey = project?.apiKey;
      sentryProject = project?.sentryProject;
      addLog("Fetch project config", "ok", projectApiKey ? "API key found" : "No API key");
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
    mcpServers = ensureForgeMcp(mcpServers, projectApiKey, sentryProject);

    // Save local config
    try {
      const updated: AppConfig = {
        ...config,
        projects: {
          ...config.projects,
          [slug]: { slug, repoPath, branch, instructions, mcpServers },
        },
      };
      setConfig(updated);
      await invoke("save_config", { config: updated });
      addLog("Save local config", "ok");
    } catch (err) {
      addLog("Save local config", "error", String(err));
      setSaving(false);
      return;
    }

    // Sync repoPath to device record in Strapi
    if (repoPath && config.deviceId) {
      try {
        await setDeviceProjectPath(config.deviceId, slug, repoPath);
        addLog("Sync to server", "ok", `Device ${config.deviceId}`);
      } catch (err) {
        addLog("Sync to server", "error", String(err));
      }
    } else {
      addLog("Sync to server", "skip", !repoPath ? "No path" : "No device ID");
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return {
    slug,
    repoPath,
    setRepoPath,
    branch,
    setBranch,
    instructions,
    setInstructions,
    saved,
    saving,
    saveLog,
    indexingRepo,
    indexStatus,
    indexLog,
    handleIndex,
    handleSave,
  };
}
