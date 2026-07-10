import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { patchAgentSession } from "@/lib/api";
import { mapStreamChunkToJobEvents } from "@/lib/job-event-mapper";
import { SessionTracker } from "@/lib/session-tracker";
import { handleAgentComplete, handleNonJobAgentComplete } from "@/lib/ws/agent-complete";
import { createDeviceHeartbeat } from "@/lib/ws/heartbeat";
import { createJobEventBatcher, createRelayBatcher } from "@/lib/ws/job-event-batcher";
import { registerAllRunners, subscribeToProjectRooms } from "@/lib/ws/runner-registration";
import { routeWsMessage, type WsRouterContext } from "@/lib/ws/ws-message-router";
import { startWsTransport } from "@/lib/ws/ws-transport";
import { accumulateJobUsage } from "@/lib/ws/usage-accumulator";
import { useAppStore } from "@/stores/app-store";
import { useAgentCommandHandler } from "./use-agent-commands";
import { useJobAssignedHandler } from "./use-job-handler";
import { useAuth } from "./useAuth";

// Single tracker instance shared across the hook lifecycle (module-level so it
// survives hook remounts during an active dispatch). The `remotePersist`
// callback writes the in-flight session snapshot to the canonical
// agent_sessions row every ~30s or every 5 messages so a desktop crash
// mid-stream still leaves the running turn visible on web (ISS-84).
const tracker = new SessionTracker({
  remotePersist: (agentSessionId, snap) =>
    patchAgentSession(agentSessionId, {
      status: "running",
      messages: snap.messages,
      claudeSessionId: snap.claudeSessionId,
    }),
});

/**
 * Wiring-only hook: builds the router context, registers WS event handlers,
 * and starts the transport (Tauri bridge with browser-WebSocket fallback),
 * heartbeat, and stream batchers. The subsystems live in `@/lib/ws/*`.
 */
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

  // Stable refs for agent command / job handling — avoids re-creating WS on
  // config changes.
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

    const wsUrl = coreUrl.replace(/^http/, "ws") + "/ws";

    const relayBatcher = createRelayBatcher();
    const jobEventBatcher = createJobEventBatcher();
    const heartbeat = createDeviceHeartbeat(coreUrl);

    const routerCtx: WsRouterContext = {
      queryClient,
      handleJobAssigned: (data) => void handleJobAssignedRef.current(data),
      handleAgentCommand: (event, data) => handleAgentCommandRef.current(event, data),
      jobSessionsRef,
      cancelledJobsRef,
    };

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    async function connect() {
      const transport = await startWsTransport(
        { wsUrl, token, deviceId, isCancelled: () => cancelled, onBrowserSocket: (ws) => { wsRef.current = ws; } },
        {
          onConnected: async (sendFrame, kind) => {
            setWsConnected(true);
            queryClient.invalidateQueries();
            if (kind === "tauri") {
              // No skill auto-sync on connect — the device pulls skills only on
              // a server `skill.sync` command (see ws-message-router).
              // ISS-173/175: register runners + subscribe project rooms on
              // every reconnect (this callback fires again).
              heartbeat.start();
              try {
                await subscribeToProjectRooms(sendFrame);
                await registerAllRunners(sendFrame);
              } catch (err) {
                console.warn("[runner:register] Rust path failed:", err);
              }
            } else {
              // Browser fallback: register as desktop + subscribe the device
              // room so dispatcher events reach us, then project rooms/runners.
              void sendFrame(JSON.stringify({ type: "desktop:register", deviceId: deviceId || "" }));
              if (deviceId) {
                void sendFrame(JSON.stringify({ type: "subscribe", room: `device:${deviceId}` }));
              }
              void subscribeToProjectRooms(sendFrame);
              void registerAllRunners(sendFrame);
            }
          },
          onDisconnected: (kind) => {
            setWsConnected(false);
            if (kind === "tauri") heartbeat.stop();
            // ISS-175: drop stale bindings on disconnect — `runner.registered`
            // re-echoes on reconnect, repopulating them cleanly.
            useAppStore.getState().clearRunnerBindings();
          },
          onMessage: (data) => routeWsMessage(data, routerCtx),
          onAgentMessage: ({ sessionId, data: agentData }) => {
            // Update local session tracking (same merge logic as useAgentChat)
            tracker.handleStreamData(sessionId, agentData);
            // Job-originated sessions: fan out to BOTH job_events (pipeline
            // monitoring board) AND the user-facing relay (chat UIs on web) —
            // returning early here left web stuck for the whole run (ISS-88).
            if (jobSessionsRef.current.has(sessionId)) {
              jobEventBatcher.enqueue(sessionId, mapStreamChunkToJobEvents(agentData));
              accumulateJobUsage(sessionId, agentData);
            }
            relayBatcher.enqueue(sessionId, "agent:message", agentData);
          },
          onAgentComplete: async (payload) => {
            // Job-originated branch (drain → /complete POST → persist → relay);
            // returns true when handled (ISS-264).
            const handledAsJob = await handleAgentComplete(payload, {
              jobSessionsRef,
              cancelledJobsRef,
              jobAgentSessionsRef,
              tracker,
              flushJobEvents: () => jobEventBatcher.flush(),
              flushRelay: () => relayBatcher.flush(),
            });
            if (handledAsJob) return;
            await handleNonJobAgentComplete(payload, { tracker, flushRelay: () => relayBatcher.flush() });
          },
          onBeforeUnload: () => {
            void tracker.flushAll();
          },
        },
      );
      if (!transport) return undefined;

      return async () => {
        relayBatcher.dispose();
        jobEventBatcher.dispose();
        // Stop the heartbeat interval — without this it survives unmount /
        // coreUrl change and keeps pinging the previous core every 25 s.
        heartbeat.stop();
        transport.detach();
        if (transport.kind === "tauri") {
          await tracker.flushAll();
          tracker.dispose();
        }
        transport.close();
      };
    }

    connect().then((fn) => {
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
