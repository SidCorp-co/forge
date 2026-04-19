import { useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { relayAgentEvent, relayPromptBuilt, getIssue, getProject, getAgents, setDeviceProjectPath } from "@/lib/api";
import { buildIssuePrompt, buildMultiIssuePrompt } from "@/lib/prompt-builders";
import { buildAgentPrompt, buildAgentReindexPrompt, type AgentConfig } from "@/lib/agent-prompt";
import { SessionTracker } from "@/lib/session-tracker";

/**
 * Auto-create a local working directory for a project if no repoPath is configured.
 * Uses ~/forge-projects/<slug>/ as the standard location.
 * Persists the path to device record + local desktop config for reuse.
 * Returns { dir, isNew } — isNew=true when the directory was just created (needs git clone).
 */
/** Emit an init log entry visible in project settings */
async function emitInitLog(projectSlug: string, step: string, status: "ok" | "error" | "skip", detail?: string) {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    emit("project:init-log", { projectSlug, step, status, detail });
  } catch { /* ignore */ }
}

async function ensureRepoPath(
  repoPath: string | undefined,
  projectSlug: string | undefined,
  configRef?: { current: any },
): Promise<{ dir: string; isNew: boolean }> {
  const slug = projectSlug || "default";

  if (repoPath) {
    // Sanitize incoming path
    repoPath = repoPath.replace(/[\n\r\0]/g, "");
    try {
      await invoke("ensure_directory", { path: repoPath });
      await emitInitLog(slug, "Validate repo path", "ok", repoPath);
    } catch (err) {
      await emitInitLog(slug, "Validate repo path", "error", `Cannot access ${repoPath}: ${err}`);
    }
    // Persist to device record so web UI shows as initialized
    if (configRef?.current?.deviceId && projectSlug) {
      try {
        await setDeviceProjectPath(configRef.current.deviceId, projectSlug, repoPath);
      } catch { /* ignore */ }
    }
    return { dir: repoPath, isNew: false };
  }

  // Resolve parent folder: config.projectsRoot > WSL home > Windows home
  let root = configRef?.current?.projectsRoot;
  let rootSource = "config";
  if (!root) {
    // Prefer WSL home (repos typically live on WSL filesystem)
    const wslHome = ((await invoke<string>("get_wsl_home").catch(() => "")) || "").replace(/[\n\r\0]/g, "");
    if (wslHome) {
      root = `${wslHome}\\forge-projects`;
      rootSource = "WSL home";
    } else {
      const homedir = await invoke<string>("get_homedir").catch(() => "");
      root = homedir ? `${homedir}\\forge-projects` : `C:\\forge-projects`;
      rootSource = "system home";
    }
  }
  const sep = root.includes("\\") ? "\\" : "/";
  // Sanitize: strip newlines/NULs that can come from WSL path resolution
  const dir = `${root.replace(/[\\/]+$/, "")}${sep}${slug}`.replace(/[\n\r\0]/g, "");
  await emitInitLog(slug, "Resolve project path", "ok", `${dir} (from ${rootSource})`);

  try {
    await invoke("ensure_directory", { path: dir });
    await emitInitLog(slug, "Create directory", "ok", dir);
  } catch (err) {
    await emitInitLog(slug, "Create directory", "error", `${dir}: ${err}`);
  }

  // Persist to device's projectPaths in Strapi
  if (configRef?.current?.deviceId && projectSlug) {
    try {
      await setDeviceProjectPath(configRef.current.deviceId, projectSlug, dir);
      await emitInitLog(slug, "Sync to server", "ok");
    } catch (err) {
      await emitInitLog(slug, "Sync to server", "error", String(err));
    }
  }

  // Persist to local desktop config
  if (configRef && projectSlug) {
    try {
      const cfg = configRef.current;
      const pc = cfg.projects[projectSlug] || { slug: projectSlug, repoPath: "" };
      pc.repoPath = dir;
      cfg.projects[projectSlug] = pc;
      await invoke("save_config", { config: cfg });
      await emitInitLog(slug, "Save local config", "ok");
    } catch (err) {
      await emitInitLog(slug, "Save local config", "error", String(err));
    }
  }

  return { dir, isNew: true };
}

/**
 * Build a setup preamble for the Claude CLI agent when a project directory is new.
 * Clones the repo and syncs skills so the agent can work immediately.
 */
async function buildSetupPreamble(projectSlug: string): Promise<string> {
  try {
    const project = await getProject(projectSlug);
    const repoUrl = (project as any).previewDeploy?.repoUrl;
    const branch = project.baseBranch || "main";
    if (!repoUrl) return "";
    return [
      "IMPORTANT: This is a fresh project directory. Before doing anything else, run these setup steps:",
      `1. Clone the repository: git clone -b ${branch} ${repoUrl} .`,
      "2. Install dependencies (npm install, pip install, etc.) if a package manager config exists.",
      "3. Then proceed with the original task below.",
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Returns a stable ref holding the agent command handler.
 * Assign `handlerRef.current` inside your render loop to keep it fresh
 * without recreating the WebSocket connection.
 */
export function useAgentCommandHandler(tracker: SessionTracker) {
  const { config } = useAppStore();
  const configRef = useRef(config);
  configRef.current = config;

  const handlerRef = useRef(async (_event: string, _data: any) => {});

  handlerRef.current = async (event: string, data: any) => {
    const cfg = configRef.current;
    const pc = data.projectSlug ? cfg.projects[data.projectSlug] : undefined;
    const mcpServers =
      pc?.mcpServers && Object.keys(pc.mcpServers).length > 0
        ? pc.mcpServers
        : undefined;

    // No context prefix needed — skill fetches its own data via MCP
    const contextPrefix = "";

    // Emit user message to local UI so useAgentChat can display it
    async function emitUserMessage(sessionId: string, message: string) {
      try {
        const { emit } = await import("@tauri-apps/api/event");
        emit("agent:user-message", { sessionId, content: message });
      } catch {
        /* ignore */
      }
    }

    if (event === "agent:start") {
      const { sessionId, prompt, projectSlug, preBuilt, systemPrompt, skill, model } = data;
      // Prefer projectsRoot/slug over per-project repoPath
      const rawPath = data.repoPath || pc?.repoPath;
      const { dir: repoPath, isNew } = await ensureRepoPath(rawPath, projectSlug, configRef);
      console.log(
        "[agent:start] repoPath:",
        repoPath,
        "local:",
        pc?.repoPath,
        "strapi:",
        data.repoPath,
        "resolved:",
        isNew ? "auto-created" : "existing",
        "preBuilt:",
        !!preBuilt,
      );
      // If directory is newly created, prepend clone + setup instructions
      const setupPreamble = isNew && projectSlug ? await buildSetupPreamble(projectSlug) : "";
      const enrichedPrompt = setupPreamble + (preBuilt ? prompt : contextPrefix + prompt);

      // Notify local UI to adopt this session (so useAgentChat shows running status)
      try {
        const { emit } = await import("@tauri-apps/api/event");
        emit("agent:session-adopted", { sessionId, prompt, projectSlug });
      } catch {
        /* ignore */
      }

      // Track session locally — same save logic as desktop-originated sessions
      tracker.start(sessionId, projectSlug ?? "", prompt, { repoPath });

      await emitInitLog(projectSlug ?? "", "Start Claude CLI", "ok", `session=${sessionId.slice(0, 8)} path=${repoPath}`);
      try {
        await invoke("send_chat", {
          repoPath,
          message: enrichedPrompt,
          sessionId,
          claudeSessionId: null,
          projectSlug,
          mcpServers,
          systemPrompt,
          skill,
          model,
        });
      } catch (err) {
        await emitInitLog(projectSlug ?? "", "Claude CLI failed", "error", String(err));
        try {
          await relayAgentEvent(sessionId, "agent:complete", {
            error: String(err),
          });
        } catch {
          /* ignore */
        }
      }
    } else if (event === "agent:send") {
      const { sessionId, message, claudeSessionId, projectSlug } = data;
      const { dir: repoPath } = await ensureRepoPath(data.repoPath || pc?.repoPath, projectSlug, configRef);
      await emitUserMessage(sessionId, message);
      tracker.addUserMessage(sessionId, message, claudeSessionId);
      try {
        await invoke("send_chat", {
          sessionId,
          message,
          claudeSessionId,
          repoPath,
          projectSlug,
          mcpServers,
        });
      } catch (err) {
        try {
          await relayAgentEvent(sessionId, "agent:complete", {
            error: String(err),
          });
        } catch {
          /* ignore */
        }
      }
    } else if (event === "agent:abort") {
      const { sessionId } = data;
      try {
        await invoke("abort_agent", { sessionId });
      } catch {
        /* ignore */
      }
    } else if (event === "agent:review" || event === "agent:reindex") {
      const { sessionId, projectSlug, agentConfig } = data;
      const { dir: repoPath } = await ensureRepoPath(data.repoPath || pc?.repoPath, projectSlug, configRef);

      // Seed agent files from Strapi before running (in case local files are missing)
      try {
        const agentType = (agentConfig as AgentConfig & { type?: string }).type
          ?.replace(/-review$/, '').replace(/-reindex$/, '');
        if (agentType) {
          const agents = await getAgents(projectSlug);
          const agent = agents.find(a => a.type?.startsWith(agentType));
          if (agent && (agent.knowledge || agent.memory)) {
            await invoke("seed_agent_files", {
              repoPath,
              agentType: `${agentType}-agent`,
              knowledge: agent.knowledge || null,
              memory: agent.memory || null,
            });
          }
        }
      } catch { /* ignore seed errors */ }

      const prompt =
        event === "agent:review"
          ? buildAgentPrompt(agentConfig as AgentConfig, projectSlug)
          : buildAgentReindexPrompt(agentConfig as AgentConfig, projectSlug);

      // Notify local UI to adopt this session
      try {
        const { emit } = await import("@tauri-apps/api/event");
        emit("agent:session-adopted", { sessionId, prompt, projectSlug });
      } catch {
        /* ignore */
      }

      tracker.start(sessionId, projectSlug ?? "", prompt, { repoPath });

      try {
        await invoke("send_chat", {
          repoPath,
          message: prompt,
          sessionId,
          claudeSessionId: null,
          projectSlug,
          mcpServers,
        });
      } catch (err) {
        try {
          await relayAgentEvent(sessionId, "agent:complete", {
            error: String(err),
          });
        } catch {
          /* ignore */
        }
      }
    } else if (event === "agent:build-prompt") {
      const { requestId, projectSlug: ps, issueIds } = data;
      console.log("[build-prompt] desktop received", {
        requestId,
        projectSlug: ps,
        issueIds,
      });

      try {
        const issues = await Promise.all(
          (issueIds as string[]).map((id: string) => getIssue(id)),
        );
        console.log("[build-prompt] fetched issues:", issues.length);

        const prompt =
          issues.length === 1
            ? buildIssuePrompt(issues[0])
            : buildMultiIssuePrompt(issues);

        console.log(
          "[build-prompt] built prompt, length:",
          prompt.length,
          "relaying back...",
        );
        await relayPromptBuilt(requestId, prompt);
        console.log("[build-prompt] relay success");
      } catch (err) {
        console.error("[build-prompt] Failed to build prompt:", err);
        try {
          await relayPromptBuilt(requestId, "", String(err));
        } catch {
          /* ignore */
        }
      }
    }
  };

  return handlerRef;
}
