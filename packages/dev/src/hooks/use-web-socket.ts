import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/app-store";
import { useAuth } from "@/hooks/useAuth";
import { invoke } from "./use-tauri-ipc";
import { relayAgentEvent, patchAgentSession, getProject, getAgents, syncKnowledgeToCore, syncAgentFiles, postJobEvents, completeJob, type JobEventInput } from "@/lib/api";
import { syncAllProjectSkills, syncProjectSkills } from "@/lib/skill-sync";
import { SessionTracker } from "@/lib/session-tracker";
import { useAgentCommandHandler } from "./use-agent-commands";
import { useJobAssignedHandler } from "./use-job-handler";
import { mapStreamChunkToJobEvents } from "@/lib/job-event-mapper";

// Single tracker instance shared across the hook lifecycle. The
// `remotePersist` callback writes the in-flight session snapshot to the
// canonical agent_sessions row every ~30s or every 5 messages so a desktop
// crash mid-stream still leaves the running turn visible on web (ISS-84).
const tracker = new SessionTracker({
  remotePersist: (agentSessionId, snap) =>
    patchAgentSession(agentSessionId, {
      status: "running",
      messages: snap.messages,
      claudeSessionId: snap.claudeSessionId,
    }),
});

export function useWebSocket() {
  const setWsConnected = useAppStore((s) => s.setWsConnected);
  const setDeviceSettings = useAppStore((s) => s.setDeviceSettings);
  const auth = useAuth();
  const phase = auth.phase;
  const coreUrl = auth.coreUrl;
  const deviceId = auth.deviceId;
  const token = auth.token;
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  // Stable ref for agent command handling — avoids re-creating WS on config changes
  const handleAgentCommandRef = useAgentCommandHandler(tracker);
  const { handlerRef: handleJobAssignedRef, jobSessionsRef, cancelledJobsRef, jobAgentSessionsRef } = useJobAssignedHandler(tracker);

  useEffect(() => {
    // Only connect when fully authenticated. On `expire()` the auth store
    // flips token → null and phase → 'expired'; without this guard the effect
    // tore the WS down and immediately reconnected without a JWT subprotocol,
    // which raced the navigate-to-/login subscriber and triggered an
    // unauthenticated `device:register`.
    if (phase !== "authenticated") return;
    if (!coreUrl) return;

    // ISS-286: token never goes in the URL — it leaks via nginx access logs,
    // browser history, and Referer. Tauri Rust path attaches the device
    // token via Authorization header (see websocket/mod.rs); browser fallback
    // path uses the `forge.bearer.<jwt>` Sec-WebSocket-Protocol subprotocol.
    const wsUrl = coreUrl.replace(/^http/, "ws") + "/ws";

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
        // Trace via console.warn so fe_log forwarder relays to stdout for debugging
        console.warn(`[ws-msg] ${event || "(no event)"}`, msg.data ? Object.keys(msg.data).join(",") : "");

        if (event === "job.assigned") {
          handleJobAssignedRef.current(msg.data);
          return;
        }
        if (event === "job.cancel") {
          const jobId = msg.data?.jobId;
          if (jobId) {
            // Tag the job as cancelled so the eventual agent:complete maps to
            // exitCode -1 (cancelled), not 1 (failed → triggers retry).
            cancelledJobsRef.current.add(jobId);
            // If abort fails (e.g. cancel arrived before send_chat registered
            // the session locally), agent:complete will never fire and the
            // job would sit dispatched forever. Converge directly by posting
            // /complete with exitCode -1 so the dispatcher records cancelled
            // rather than failed (which would also trigger scheduleRetry).
            invoke("abort_agent", { sessionId: jobId }).catch(async () => {
              jobSessionsRef.current.delete(jobId);
              cancelledJobsRef.current.delete(jobId);
              try { await completeJob(jobId, -1, { error: "cancelled before runner accepted job" }); } catch { /* ignore */ }
            });
          }
          return;
        }

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

        // EPIC 6 (ISS-278/290/292) — single-skill update broadcast from
        // packages/core when a project override is upserted/deleted via the web
        // UI. We don't get the new content in the payload (per project room
        // privacy) — re-pull /effective for the affected project.
        if (event === "skill.updated") {
          const projectId = msg.data?.projectId;
          if (!projectId) return;
          (async () => {
            try {
              const currentConfig = await invoke<any>("get_config");
              const projects = currentConfig?.projects ?? {};
              for (const [slug, p] of Object.entries<any>(projects)) {
                if (!p?.repoPath) continue;
                // syncProjectSkills resolves slug→id internally; cheaper than
                // tracking id→slug separately here. Each project's effective
                // list is bounded (~10 skills) so the extra fetch is fine.
                try {
                  await syncProjectSkills(slug, p.repoPath);
                } catch { /* per-project skip */ }
              }
              queryClient.invalidateQueries({ queryKey: ["skill-sync-log"] });
            } catch { /* ignore */ }
          })();
          return;
        }

        if (event === "config:sync-project") {
          handleConfigSyncProject(msg.data);
          return;
        }

        if (event === "notification:created" || event === "notification.created") {
          ["notifications", "notifications-unread", "pm-escalations"].forEach((k) =>
            queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
          );
        }

        // ISS-22 — PM agent escalation. Broadcast by Epic 5; refresh the
        // inbox + notifications cache so the bell badge and PmInbox pick it up.
        if (event === "pm.escalation") {
          ["pm-escalations", "notifications", "notifications-unread"].forEach((k) =>
            queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
          );
          return;
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
        ws.send(JSON.stringify({ type: "desktop:register", deviceId: deviceId || "" }));
      }
    }

    // ISS-271: Register a `claude-code` runner with the server's runner
    // framework. Server ignores when `runnerFramework` flag is off, so it's
    // safe to send unconditionally. The runnerId returned by the server
    // arrives via `runner.registered` WS message (handled in handleMessage).
    //
    // Tauri Rust WS path does not currently expose a way to send arbitrary
    // outbound messages from JS — this branch fires only via the browser
    // fallback (`new WebSocket(wsUrl)`). A follow-up issue (tracked in the
    // PR-B comment) will add a `ws_send` Tauri command and call it from the
    // `ws:connected` listener above.
    async function registerAsRunner(ws: WebSocket) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const settings = useAppStore.getState().deviceSettings;
      const projectSlug = Object.keys(settings.projects ?? {})[0];
      const projects = settings.projects as Record<string, { documentId?: string }> | undefined;
      const projectId = projectSlug ? projects?.[projectSlug]?.documentId : undefined;
      if (!projectId) return;
      let skills: string[] = [];
      try {
        const hashes = (await invoke<Record<string, string>>("get_skill_hashes")) ?? {};
        skills = Object.keys(hashes);
      } catch {
        // tauri unavailable; runner registers with empty skills
      }
      ws.send(
        JSON.stringify({
          type: "runner:register",
          data: {
            type: "claude-code",
            name: (await invoke<string>("get_hostname").catch(() => "Desktop")) || "Desktop",
            projectId,
            capabilities: { skills, maxConcurrent: 1 },
            config: {},
          },
        }),
      );
    }

    let cancelled = false;

    async function setupListeners() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return undefined;

        // Periodic heartbeat to keep device.status = 'online' on the core.
        // /api/devices/heartbeat is the only path that flips status; without
        // this loop the device stays 'offline' and dispatcher leaves jobs
        // queued. 25s interval is well under the stale-detector grace window.
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        async function pingHeartbeat() {
          try {
            const tok = await invoke<string | null>("load_device_token");
            if (!tok || !coreUrl) return;
            await invoke("heartbeat", { coreUrl: coreUrl, deviceToken: tok });
          } catch {
            // ignore — keychain unavailable or device not yet paired
          }
        }
        function startHeartbeat() {
          if (heartbeatTimer) return;
          void pingHeartbeat();
          heartbeatTimer = setInterval(() => void pingHeartbeat(), 25_000);
        }
        function stopHeartbeat() {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        }

        console.warn("[ws-debug] tauri listen() registered — Rust WS path active");
        const unlisten1 = await listen("ws:connected", async () => {
          console.warn("[ws-debug] ws:connected event fired");
          setWsConnected(true);
          queryClient.invalidateQueries();
          startHeartbeat();
          // Auto-sync skills from core for all configured projects
          try {
            const settings = useAppStore.getState().deviceSettings;
            const synced = await syncAllProjectSkills(settings.projects);
            if (synced) {
              const updatedDisk = await invoke<any>("get_config");
              if (updatedDisk) {
                setDeviceSettings({
                  projects: updatedDisk.projects ?? {},
                  projectsRoot: updatedDisk.projectsRoot,
                  skillLibrary: updatedDisk.skillLibrary,
                  mcpLibrary: updatedDisk.mcpLibrary,
                });
              }
            }
          } catch { /* ignore */ }
        });
        const unlisten2 = await listen("ws:disconnected", async () => {
          setWsConnected(false);
          stopHeartbeat();
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

        // ISS-84 — drain pending incremental PATCHes before the renderer
        // tears down on a cooperative window close. Best-effort: fire-and-
        // forget since `beforeunload` does not await async work.
        const onBeforeUnload = () => { void tracker.flushAll(); };
        window.addEventListener("beforeunload", onBeforeUnload);

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

        // Job event batch (parallel to relayQueue): chunks bound for packages/core's
        // /api/jobs/:id/events. Same 100ms cadence; per-job batches are post.
        const jobEventQueue = new Map<string, JobEventInput[]>();
        let jobFlushTimer: ReturnType<typeof setTimeout> | null = null;
        // Chain in-flight flushes so agent:complete can `await` the tail
        // before calling /complete — otherwise the timer-driven flush (which
        // clears the queue immediately and awaits the POST) can finish AFTER
        // /complete lands and the still-in-flight events get 409 JOB_TERMINATED.
        let jobFlushInFlight: Promise<void> = Promise.resolve();

        function flushJobEvents(): Promise<void> {
          jobFlushTimer = null;
          if (jobEventQueue.size === 0) return jobFlushInFlight;
          const drained: Array<[string, JobEventInput[]]> = Array.from(jobEventQueue.entries());
          jobEventQueue.clear();
          // Chain so back-to-back flushes serialize and `await jobFlushInFlight`
          // from agent:complete waits for every queued POST to land.
          jobFlushInFlight = jobFlushInFlight.then(async () => {
            for (const [jobId, events] of drained) {
              if (events.length === 0) continue;
              try {
                await postJobEvents(jobId, events);
              } catch (err) {
                console.error(`[job-events] flush failed for ${jobId}:`, err);
              }
            }
          });
          return jobFlushInFlight;
        }

        function enqueueJobEvents(jobId: string, events: JobEventInput[]) {
          if (events.length === 0) return;
          let arr = jobEventQueue.get(jobId);
          if (!arr) {
            arr = [];
            jobEventQueue.set(jobId, arr);
          }
          arr.push(...events);
          if (!jobFlushTimer) {
            jobFlushTimer = setTimeout(flushJobEvents, FLUSH_INTERVAL);
          }
        }

        const unlisten5 = await listen<{ sessionId: string; data: any }>(
          "agent:message",
          (event) => {
            const { sessionId, data: agentData } = event.payload;
            // Update local session tracking (same merge logic as useAgentChat)
            tracker.handleStreamData(sessionId, agentData);
            // Job-originated session: route stream to job_events instead of the
            // user-facing relay (which would broadcast to chat UIs).
            if (jobSessionsRef.current.has(sessionId)) {
              const jobEvents = mapStreamChunkToJobEvents(agentData);
              enqueueJobEvents(sessionId, jobEvents);
              return;
            }
            enqueueRelay(sessionId, "agent:message", agentData);
          },
        );

        const unlisten6 = await listen<{ sessionId: string; claudeSessionId?: string | null; error?: string }>(
          "agent:complete",
          async (event) => {
            const { sessionId, ...rest } = event.payload;

            // Job-originated session: drain job_event batch, finalize via
            // /api/jobs/:id/complete, skip user-facing relay + knowledge sync.
            //
            // Keep the jobSessionsRef marker (don't delete) — the Rust spawn
            // layer can emit late stream chunks after agent:complete, and we
            // don't want those leaking through enqueueRelay to user chat UIs.
            // jobId is a UUID, so the bounded growth is acceptable.
            if (jobSessionsRef.current.has(sessionId)) {
              // Trigger any pending batch and await the in-flight chain so
              // every queued event POST lands BEFORE /complete moves the job
              // to a terminal status (which would 409 in-flight POSTs).
              flushJobEvents();
              await jobFlushInFlight;
              // Cancellation lands `cancelled` (exitCode -1), normal error
              // lands `failed` (1), success lands `done` (0). See lifecycle
              // routes mapping in packages/core/src/jobs/lifecycle-routes.ts.
              const wasCancelled = cancelledJobsRef.current.delete(sessionId);
              const exitCode = wasCancelled ? -1 : rest.error ? 1 : 0;
              try {
                await completeJob(sessionId, exitCode, { error: rest.error ?? null });
              } catch (err) {
                console.error(`[job-events] completeJob failed for ${sessionId}:`, err);
              }

              // Persist the canonical agent_sessions row so a browser opening
              // the pipeline session AFTER completion sees the assistant
              // reply, claudeSessionId, and (eventual) diff. completeJob
              // above only flips the row's status via syncAgentSessionLifecycle
              // — without this PATCH the row keeps messages=[] forever.
              // The agentSessionId is surfaced by core in the job.assigned WS
              // payload (PR-B); absent against older server builds, in which
              // case we silently skip — the status sync still applied.
              const agentSessionId = jobAgentSessionsRef.current.get(sessionId);
              if (agentSessionId) {
                try {
                  const snap = tracker.getSnapshot(sessionId);
                  if (!snap) {
                    console.warn(
                      `[agent:complete] tracker snapshot missing for job=${sessionId} — PATCH will omit messages, expect persisted history to be incomplete`,
                    );
                  }
                  await patchAgentSession(agentSessionId, {
                    status: wasCancelled ? "completed" : rest.error ? "failed" : "completed",
                    ...(snap ? { messages: snap.messages, claudeSessionId: snap.claudeSessionId } : {}),
                  });
                } catch (err) {
                  console.warn(`[agent:complete] PATCH session row failed for job ${sessionId}:`, err);
                }
                jobAgentSessionsRef.current.delete(sessionId);
              }

              tracker.complete(sessionId);
              return;
            }

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

            // ISS-307 — persist the session row so a browser opening this
            // session AFTER completion still sees the assistant reply +
            // running flag clearing. The relay above is broadcast-only;
            // without this PATCH the DB row stays stuck at
            // status='running' / messages=[user-only]. Best-effort: sync
            // failures must not block local cleanup or knowledge sync.
            try {
              const snap = tracker.getSnapshot(sessionId);
              if (!snap) {
                console.warn(
                  `[agent:complete] tracker snapshot missing for session ${sessionId} — PATCH will omit messages, expect persisted history to be incomplete`,
                );
              }
              await patchAgentSession(sessionId, {
                status: rest.error ? "failed" : "completed",
                ...(snap ? { messages: snap.messages, claudeSessionId: snap.claudeSessionId } : {}),
                ...(diffData ? { diff: diffData } : {}),
              });
            } catch (err) {
              console.warn("[agent:complete] PATCH session failed:", err);
            }

            // Sync local files to core after agent sessions complete
            if (trackedSession?.repoPath && trackedSession?.slug && !rest.error) {
              try {
                const project = await getProject(trackedSession.slug);

                // Sync .forge/knowledge.json → project.knowledgeIndex + Qdrant
                const knowledge = await invoke<Record<string, unknown> | null>("read_knowledge_index", { repoPath: trackedSession.repoPath });
                if (knowledge && project?.documentId) {
                  // Wrap flat KnowledgeIndex in repo-keyed map if not already wrapped
                  // Display expects Record<string, KnowledgeIndex>, local file is flat KnowledgeIndex
                  const isFlat = 'project' in knowledge || 'architecture' in knowledge || 'domains' in knowledge;
                  const wrapped = isFlat ? { [trackedSession.slug]: knowledge } : knowledge;
                  await syncKnowledgeToCore(project.documentId, wrapped, project.documentId);
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

        // Load device token from the OS keychain (ISS-214 §5). Sent as
        // `Authorization: Bearer <token>`. Anonymous sockets are still
        // accepted server-side; Phase 2.2 enforcement flips that on.
        let deviceToken: string | undefined;
        try {
          const tok = await invoke<string | null>("load_device_token");
          if (tok) deviceToken = tok;
        } catch { /* keychain unavailable — connect anonymously */ }

        await invoke("connect_ws", {
          url: wsUrl,
          deviceToken,
          deviceId: deviceId || undefined,
        });

        return async () => {
          if (flushTimer) clearTimeout(flushTimer);
          if (jobFlushTimer) clearTimeout(jobFlushTimer);
          // Stop the heartbeat interval — without this it survives unmount /
          // coreUrl change and keeps pinging the previous core every 25 s.
          stopHeartbeat();
          window.removeEventListener("beforeunload", onBeforeUnload);
          await tracker.flushAll();
          tracker.dispose();
          unlisten1();
          unlisten2();
          unlisten3();
          unlisten4();
          unlisten5();
          unlisten6();
        };
      } catch (err) {
        // Not in Tauri — use native WebSocket as fallback. Pass the user JWT
        // via Sec-WebSocket-Protocol subprotocol (ISS-286) so the token
        // never appears in the URL / access logs / Referer.
        console.warn("[ws-debug] tauri listen() failed → browser fallback", err);
        const protocols = token ? [`forge.bearer.${token}`] : undefined;
        const ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          console.warn("[ws-debug] browser WS open — sending subscribe device:", deviceId);
          setWsConnected(true);
          queryClient.invalidateQueries();
          registerAsDesktop(ws);
          // Subscribe to device room so dispatcher events reach us in browser fallback path
          if (deviceId) {
            ws.send(JSON.stringify({ type: "subscribe", room: `device:${deviceId}` }));
          }
          void registerAsRunner(ws);
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
  }, [phase, coreUrl, deviceId, token, setWsConnected, setDeviceSettings, queryClient, handleAgentCommandRef, handleJobAssignedRef, jobSessionsRef, cancelledJobsRef, jobAgentSessionsRef]);
}
