import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { registerDesktop, unregisterDesktop, registerDevice, relayAgentEvent, relayPromptBuilt, getIssue, getComments, getProject, getAgents, syncKnowledgeToStrapi, syncAgentFiles } from "@/lib/api";
import { buildIssuePrompt, buildMultiIssuePrompt } from "@/lib/prompt-builders";
import { buildAgentPrompt, buildAgentReindexPrompt, type AgentConfig } from "@/lib/agent-prompt";
import { SessionTracker } from "@/lib/session-tracker";
import { syncAllProjectSkills } from "@/lib/skill-sync";
import { useAgentCommandHandler } from "./use-agent-commands";

// Single tracker instance shared across the hook lifecycle
const tracker = new SessionTracker();

export function useWebSocket() {
  const { config, setConfig, setWsConnected } = useAppStore();
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  // Stable ref for agent command handling — avoids re-creating WS on config changes
  const handleAgentCommandRef = useAgentCommandHandler(tracker);

  useEffect(() => {
    if (!config.strapiUrl) return;

    const wsUrl = config.strapiUrl.replace(/^http/, "ws") + "/ws";

    async function handleSkillsPush(data: any) {
      const skills: Array<{
        name: string;
        skillMd?: string;
        localGuide?: string;
        target?: string;
        description?: string;
        version?: string;
        contentHash?: string;
        files?: Array<{ path: string; content: string; encoding: string }>;
      }> = data?.skills || [];

      // Get local hashes to skip unchanged skills
      let localHashes: Record<string, string> = {};
      try {
        localHashes = await invoke<Record<string, string>>("get_skill_hashes") || {};
      } catch { /* ignore */ }

      for (const skill of skills) {
        // Skip if hash matches (already up to date)
        if (skill.contentHash && localHashes[skill.name] === skill.contentHash) {
          continue;
        }

        try {
          const target = skill.target || "dev";
          if (target === "cloud" || target === "all") {
            const guideContent = skill.localGuide
              || `# ${skill.name}\n${skill.description || ""}\n\nTo load the current version, call: forge_skills get ${skill.name}`;
            await invoke("install_skill_guide", {
              data: {
                name: skill.name,
                description: skill.description || "",
                version: skill.version || "1.0.0",
                localGuide: guideContent,
                contentHash: skill.contentHash || null,
              },
            });
          } else {
            await invoke("install_skill_from_strapi", {
              data: {
                name: skill.name,
                description: skill.description || "",
                version: skill.version || "1.0.0",
                skillMd: skill.skillMd || "",
                files: skill.files || [],
                contentHash: skill.contentHash || null,
              },
            });
          }
        } catch (err) {
          console.error(`[skills:push] Failed: ${skill.name}`, err);
        }
      }

      // Sync project paths from server before refreshing, so newly-initialized
      // projects are in config.projects and receive the skill files.
      try {
        const deviceId = config.deviceId || "";
        const hostname = await invoke<string>("get_hostname").catch(() => "Desktop");
        const device = await registerDevice(deviceId, hostname as string);
        if (device?.projectPaths) {
          const currentConfig = await invoke<any>("get_config");
          const merged = { ...currentConfig.projects };
          let changed = false;
          for (const [slug, path] of Object.entries(device.projectPaths)) {
            if (!path) continue;
            if (!merged[slug]) {
              merged[slug] = { slug, repoPath: path };
              changed = true;
            } else if (!merged[slug].repoPath) {
              merged[slug] = { ...merged[slug], repoPath: path };
              changed = true;
            }
          }
          if (changed) {
            await invoke("save_config", { config: { ...currentConfig, projects: merged } });
          }
        }
      } catch { /* ignore */ }

      // Refresh all projects — this saves the sync log to disk
      try {
        await invoke("refresh_enabled_skills");
      } catch (err) {
        console.error("[skills:push] refresh failed:", err);
      }
      // Notify UI that sync log has been updated
      queryClient.invalidateQueries({ queryKey: ["skill-sync-log"] });
    }

    async function handleConfigSyncProject(data: any) {
      const { projectSlug, repoPath } = data || {};
      if (!projectSlug || !repoPath) return;
      try {
        const currentConfig = await invoke<any>("get_config");
        const projects = { ...currentConfig.projects };
        const existing = projects[projectSlug] || { slug: projectSlug };
        if (existing.repoPath === repoPath) return; // already set
        projects[projectSlug] = { ...existing, repoPath };
        await invoke("save_config", { config: { ...currentConfig, projects } });
      } catch { /* ignore */ }
    }

    function handleMessage(data: any) {
      try {
        const msg = typeof data === "string" ? JSON.parse(data) : data;
        const event: string = msg.event ?? "";

        if (
          event === "agent:start" ||
          event === "agent:send" ||
          event === "agent:abort" ||
          event === "agent:build-prompt" ||
          event === "agent:review" ||
          event === "agent:reindex"
        ) {
          handleAgentCommandRef.current(event, msg.data);
          return;
        }

        if (event === "skills:push") {
          handleSkillsPush(msg.data);
          return;
        }

        if (event === "config:sync-project") {
          handleConfigSyncProject(msg.data);
          return;
        }

        if (event === "notification:created") {
          ["notifications", "notifications-unread"].forEach((k) =>
            queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
          );
        }

        if (
          event.startsWith("issue:") ||
          event.startsWith("task:") ||
          event.startsWith("agent:")
        ) {
          const keys =
            event.startsWith("task:") || event.startsWith("agent:")
              ? ["tasks"]
              : ["issues", "issue", "comments"];
          keys.forEach((k) =>
            queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
          );
        }
      } catch {
        // ignore
      }
    }

    function registerAsDesktop(ws: WebSocket) {
      if (ws.readyState === WebSocket.OPEN) {
        const deviceId = config.deviceId || "";
        ws.send(JSON.stringify({ type: "desktop:register", deviceId }));
      }
    }

    let cancelled = false;

    async function setupListeners() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return undefined;

        const unlisten1 = await listen("ws:connected", async () => {
          setWsConnected(true);
          queryClient.invalidateQueries();
          const deviceId = config.deviceId || "";
          try {
            await registerDesktop(deviceId);
          } catch { /* ignore */ }
          // Register device entity with a hostname, sync projectsRoot + projectPaths from server
          try {
            const hostname = await invoke<string>("get_hostname").catch(() => "Desktop");
            const device = await registerDevice(deviceId, hostname as string);
            let needsSave = false;
            const updated = { ...config };
            if (device?.projectsRoot && !config.projectsRoot) {
              updated.projectsRoot = device.projectsRoot;
              needsSave = true;
            }
            // Restore per-project repo paths from device record
            if (device?.projectPaths) {
              const merged = { ...updated.projects };
              for (const [slug, path] of Object.entries(device.projectPaths)) {
                if (!path) continue;
                if (!merged[slug]) {
                  merged[slug] = { slug, repoPath: path };
                  needsSave = true;
                } else if (!merged[slug].repoPath) {
                  merged[slug] = { ...merged[slug], repoPath: path };
                  needsSave = true;
                }
              }
              if (needsSave) updated.projects = merged;
            }
            if (needsSave) {
              await invoke("save_config", { config: updated });
            }
          } catch { /* ignore */ }
          // Auto-sync skills from Strapi for all configured projects
          try {
            const synced = await syncAllProjectSkills(config);
            if (synced) {
              const updated = await invoke("get_config");
              if (updated) setConfig(updated as any);
            }
          } catch { /* ignore */ }
        });
        const unlisten2 = await listen("ws:disconnected", async () => {
          setWsConnected(false);
          const deviceId = config.deviceId || "";
          try {
            await unregisterDesktop(deviceId);
          } catch { /* ignore */ }
        });
        const unlisten3 = await listen<unknown>("ws:message", (event) => {
          handleMessage(event.payload);
        });
        // ws:error fires per failed reconnect attempt during a retry loop —
        // it is noise, not an authoritative disconnect signal. Only
        // ws:disconnected (inner read loop exited) should flip UI state.
        const unlisten4 = await listen("ws:error", () => {
          /* no-op */
        });

        // Batch relay: accumulate agent:message events and flush periodically
        const relayQueue: { sessionId: string; event: string; data: any }[] = [];
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const FLUSH_INTERVAL = 100; // ms

        async function flushRelay() {
          flushTimer = null;
          if (relayQueue.length === 0) return;
          const batch = relayQueue.splice(0, relayQueue.length);
          const bySession = new Map<string, { event: string; data: any }[]>();
          for (const item of batch) {
            let arr = bySession.get(item.sessionId);
            if (!arr) {
              arr = [];
              bySession.set(item.sessionId, arr);
            }
            arr.push({ event: item.event, data: item.data });
          }
          for (const [sid, items] of bySession) {
            try {
              await relayAgentEvent(sid, "agent:batch", { items });
            } catch {
              /* ignore */
            }
          }
        }

        function enqueueRelay(sessionId: string, event: string, data: any) {
          relayQueue.push({ sessionId, event, data });
          if (!flushTimer) {
            flushTimer = setTimeout(flushRelay, FLUSH_INTERVAL);
          }
        }

        const unlisten5 = await listen<{ sessionId: string; data: any }>(
          "agent:message",
          (event) => {
            const { sessionId, data: agentData } = event.payload;
            enqueueRelay(sessionId, "agent:message", agentData);
            // Update local session tracking (same merge logic as useAgentChat)
            tracker.handleStreamData(sessionId, agentData);
          },
        );

        const unlisten6 = await listen<{ sessionId: string; error?: string }>(
          "agent:complete",
          async (event) => {
            const { sessionId, ...rest } = event.payload;
            await flushRelay();

            // Try to compute branch diff and include it in the relay
            let diffData: unknown = undefined;
            const trackedSession = tracker.getSession(sessionId);
            const worktreeBranch = trackedSession?.worktreeBranch;
            if (worktreeBranch) {
              const repoPath = trackedSession?.repoPath;
              if (repoPath) {
                try {
                  diffData = await invoke("get_branch_diff", {
                    repoPath,
                    branch: worktreeBranch,
                    base: "HEAD",
                  });
                } catch {
                  /* ignore diff errors */
                }
              }
            }

            try {
              await relayAgentEvent(sessionId, "agent:complete", {
                ...rest,
                diff: diffData,
              });
            } catch {
              /* ignore */
            }
            // Sync local files to Strapi after agent sessions complete
            if (trackedSession?.repoPath && trackedSession?.slug && !rest.error) {
              try {
                const project = await getProject(trackedSession.slug);

                // Sync .forge/knowledge.json → project.knowledgeIndex + Qdrant
                const knowledge = await invoke<Record<string, unknown> | null>("read_knowledge_index", { repoPath: trackedSession.repoPath });
                if (knowledge && project?.apiKey) {
                  // Wrap flat KnowledgeIndex in repo-keyed map if not already wrapped
                  // Display expects Record<string, KnowledgeIndex>, local file is flat KnowledgeIndex
                  const isFlat = 'project' in knowledge || 'architecture' in knowledge || 'domains' in knowledge;
                  const wrapped = isFlat ? { [trackedSession.slug]: knowledge } : knowledge;
                  await syncKnowledgeToStrapi(project.apiKey, wrapped, project.documentId);
                }

                // Sync agent-specific files (e.g. .forge/po-agent/) → agent record
                if (project) {
                  const agents = await getAgents(trackedSession.slug);
                  for (const agent of agents) {
                    const agentDir = agent.type?.replace(/-review$/, '').replace(/-reindex$/, '') + "-agent";
                    if (!agentDir) continue;
                    const files = await invoke<{ knowledge?: string | null; memory?: string | null } | null>("read_agent_files", {
                      repoPath: trackedSession.repoPath,
                      agentType: agentDir,
                    });
                    if (files && (files.knowledge || files.memory)) {
                      await syncAgentFiles(agent.documentId, files);
                    }
                  }
                }
              } catch { /* ignore sync errors */ }
            }

            // Final save + cleanup
            tracker.complete(sessionId);
          },
        );

        await invoke("connect_ws", { url: wsUrl, deviceId: config.deviceId || undefined });

        return () => {
          if (flushTimer) clearTimeout(flushTimer);
          tracker.dispose();
          unlisten1();
          unlisten2();
          unlisten3();
          unlisten4();
          unlisten5();
          unlisten6();
        };
      } catch {
        // Not in Tauri — use native WebSocket as fallback
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          setWsConnected(true);
          queryClient.invalidateQueries();
          registerAsDesktop(ws);
        };
        ws.onclose = () => setWsConnected(false);
        ws.onmessage = (e) => handleMessage(e.data);
        return () => ws.close();
      }
    }

    let cleanup: (() => void) | undefined;
    setupListeners().then((fn) => {
      if (cancelled && fn) {
        fn();
      } else {
        cleanup = fn;
      }
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [config.strapiUrl, config.deviceId, setWsConnected, queryClient]);
}
