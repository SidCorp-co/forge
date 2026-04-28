import { useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { invoke, isTauri } from "./use-tauri-ipc";
import { failJob, resolveProjectSlug } from "@/lib/api";
import type { SessionTracker } from "@/lib/session-tracker";
import type { AppConfig, JobAssignedPayload } from "@/lib/types";

const SUPPORTED_TYPES = ["plan", "code", "review", "fix", "triage"] as const;

export function buildJobPrompt(type: string, issueId: string | undefined | null): string | null {
  if (!issueId) return null;
  if ((SUPPORTED_TYPES as readonly string[]).includes(type)) {
    return `/forge-${type} ${issueId}`;
  }
  return null;
}

export interface JobHandlerCtx {
  config: Pick<AppConfig, "projects">;
  tracker: Pick<SessionTracker, "start">;
  jobSessions: Set<string>;
}

/**
 * Pure handler — no React. Tests call this directly. The hook below wires refs.
 *
 * On entry the handler:
 *  1) resolves projectId → slug (config lookup)
 *  2) confirms a local repoPath is configured for the slug
 *  3) builds the `/forge-<type> <issueId>` prompt
 *  4) marks the session as job-owned and spawns send_chat with sessionId=jobId
 * Any failure path posts /api/jobs/:id/fail and removes the session marker so
 * dispatcher state and local state stay in sync.
 */
export async function handleJobAssigned(
  data: JobAssignedPayload | undefined,
  ctx: JobHandlerCtx,
): Promise<void> {
  if (!data?.jobId) return;
  const { jobId, projectId, type, payload } = data;
  // Dispatcher emits issueId at top level; legacy/test fixtures may put it
  // inside payload — accept both so handler works in either shape.
  const issueId = data.issueId ?? (payload?.issueId as string | undefined);

  // Outside Tauri (browser/dev mode) `send_chat` is a logged no-op and no
  // agent:* events ever fire, so the job would sit dispatched forever. Fail
  // immediately so the dispatcher can move on.
  if (!isTauri) {
    try { await failJob(jobId, "device-runner unavailable in browser mode"); } catch { /* ignore */ }
    return;
  }

  let slug: string;
  try {
    slug = await resolveProjectSlug(projectId);
  } catch (err) {
    console.error("[job.assigned] resolve project slug failed:", err);
    try { await failJob(jobId, `project not found: ${projectId}`); } catch { /* ignore */ }
    return;
  }

  const pc = ctx.config.projects?.[slug];
  if (!pc?.repoPath) {
    try { await failJob(jobId, `no repoPath configured for project ${slug}`); } catch { /* ignore */ }
    return;
  }

  const prompt = buildJobPrompt(type, issueId);
  if (!prompt) {
    try { await failJob(jobId, `unsupported job type or missing issueId (type=${type})`); } catch { /* ignore */ }
    return;
  }

  const mcpServers = pc.mcpServers && Object.keys(pc.mcpServers).length > 0 ? pc.mcpServers : undefined;

  // Mark BEFORE invoke so any stream events emitted while invoke awaits land
  // in the job-events path (not the user-relay path). On failure we keep the
  // marker — late agent:* events for this jobId must not leak to chat UIs;
  // jobId is a UUID so growth is bounded and won't collide with real sessions.
  ctx.jobSessions.add(jobId);
  ctx.tracker.start(jobId, slug, prompt, { repoPath: pc.repoPath });

  try {
    await invoke("send_chat", {
      repoPath: pc.repoPath,
      message: prompt,
      sessionId: jobId,
      claudeSessionId: null,
      projectSlug: slug,
      mcpServers,
    });
  } catch (err) {
    console.error("[job.assigned] send_chat failed:", err);
    try { await failJob(jobId, `send_chat failed: ${String(err)}`); } catch { /* ignore */ }
  }
}

export interface JobAssignedHandlerRefs {
  handlerRef: React.MutableRefObject<(data: JobAssignedPayload) => Promise<void>>;
  jobSessionsRef: React.MutableRefObject<Set<string>>;
  cancelledJobsRef: React.MutableRefObject<Set<string>>;
}

/**
 * React wrapper: keeps the handler ref fresh against the latest config without
 * recreating the WebSocket. The set of job-owned session IDs lives in a ref so
 * the agent:message/agent:complete listeners (in use-web-socket) can branch on
 * it cheaply. cancelledJobsRef tracks jobIds where job.cancel was received so
 * the eventual agent:complete reports the right exitCode (-1 = cancelled).
 */
export function useJobAssignedHandler(tracker: SessionTracker): JobAssignedHandlerRefs {
  const { config } = useAppStore();
  const configRef = useRef(config);
  configRef.current = config;

  const jobSessionsRef = useRef(new Set<string>());
  const cancelledJobsRef = useRef(new Set<string>());
  const handlerRef = useRef<(data: JobAssignedPayload) => Promise<void>>(async () => {});

  handlerRef.current = (data: JobAssignedPayload) =>
    handleJobAssigned(data, {
      config: configRef.current,
      tracker,
      jobSessions: jobSessionsRef.current,
    });

  return { handlerRef, jobSessionsRef, cancelledJobsRef };
}
