import { invoke } from "@/hooks/use-tauri-ipc";
import {
  completeJob,
  createUsageRecord,
  getAgents,
  getProject,
  patchAgentSession,
  relayAgentEvent,
  syncAgentFiles,
} from "@/lib/api";
import type { SessionTracker } from "@/lib/session-tracker";
import { clearJobUsage, readJobUsage } from "./usage-accumulator";

export type AgentCompletePayload = {
  sessionId: string;
  claudeSessionId?: string | null;
  error?: string;
};

export type HandleAgentCompleteCtx = {
  jobSessionsRef: { current: Set<string> };
  cancelledJobsRef: { current: Set<string> };
  jobAgentSessionsRef: { current: Map<string, string> };
  tracker: Pick<SessionTracker, "getSnapshot" | "complete">;
  /** Drains the pending job_event batch; resolves once every queued POST lands. */
  flushJobEvents: () => Promise<void>;
  /** Drains the pending agent:message relay batch. */
  flushRelay: () => Promise<void>;
};

/**
 * Handle the job-originated branch of `agent:complete`: drain the job_event
 * batch, POST /api/jobs/:id/complete (exitCode 0 = done, 1 = failed, -1 =
 * cancelled), persist the canonical agent_sessions row + accumulated usage, and
 * relay completion to web chat UIs. Returns `true` when the session was a
 * pipeline job (the caller should stop here); `false` for a user-facing session
 * (the caller continues to the diff / knowledge-sync branch in
 * `handleNonJobAgentComplete`).
 *
 * Extracted from the inline Tauri `agent:complete` listener so it can be unit
 * tested without a live Tauri event bus — the listener mock rejects, leaving
 * the /complete POST path otherwise unexercised (ISS-264).
 */
export async function handleAgentComplete(
  payload: AgentCompletePayload,
  ctx: HandleAgentCompleteCtx,
): Promise<boolean> {
  const { jobSessionsRef, cancelledJobsRef, jobAgentSessionsRef, tracker, flushJobEvents, flushRelay } = ctx;
  const { sessionId, ...rest } = payload;

  // Job-originated session: drain job_event batch, finalize via
  // /api/jobs/:id/complete, skip user-facing relay + knowledge sync.
  //
  // Keep the jobSessionsRef marker (don't delete) — the Rust spawn layer can
  // emit late stream chunks after agent:complete, and we don't want those
  // leaking through enqueueRelay to user chat UIs. jobId is a UUID, so the
  // bounded growth is acceptable.
  if (!jobSessionsRef.current.has(sessionId)) return false;

  // Trigger any pending batch and await the in-flight chain so every queued
  // event POST lands BEFORE /complete moves the job to a terminal status
  // (which would 409 in-flight POSTs).
  await flushJobEvents();
  // Cancellation lands `cancelled` (exitCode -1), normal error lands `failed`
  // (1), success lands `done` (0). See lifecycle routes mapping in
  // packages/core/src/jobs/lifecycle-routes.ts.
  const wasCancelled = cancelledJobsRef.current.delete(sessionId);
  const exitCode = wasCancelled ? -1 : rest.error ? 1 : 0;
  try {
    await completeJob(sessionId, exitCode, { error: rest.error ?? null });
  } catch (err) {
    console.error(`[job-events] completeJob failed for ${sessionId}:`, err);
  }

  // Persist the canonical agent_sessions row so a browser opening the pipeline
  // session AFTER completion sees the assistant reply, claudeSessionId, and
  // (eventual) diff. completeJob above only flips the row's status via
  // syncAgentSessionLifecycle — without this PATCH the row keeps messages=[]
  // forever. The agentSessionId is surfaced by core in the job.assigned WS
  // payload (PR-B); absent against older server builds, in which case we
  // silently skip — the status sync still applied.
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

    // Emit accumulated token usage as a single /usage-records row, keyed by the
    // forge agent_sessions.id so the pipeline_run_step_durations view JOIN
    // (ur.session_id = j.agent_session_id::text) actually matches. Without
    // this, every pipeline step shows totalCostUsd=0 in /metrics.
    const acc = readJobUsage(sessionId);
    if (acc && acc.count > 0) {
      try {
        await createUsageRecord({
          source: "desktop",
          model: acc.model,
          inputTokens: acc.input,
          outputTokens: acc.output,
          cacheReadTokens: acc.cacheRead,
          cacheCreationTokens: acc.cacheCreation,
          requestCount: acc.count,
          sessionId: agentSessionId,
          recordedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[agent:complete] usage POST failed for job ${sessionId}:`, err);
      }
    }

    jobAgentSessionsRef.current.delete(sessionId);
  }
  // Always drop the accumulator entry — even if no agentSessionId was surfaced
  // (older server builds), keeping it would leak memory across hot reloads and
  // long-running dev sessions.
  clearJobUsage(sessionId);

  // Mirror the relay that non-job sessions get below, so web chat UIs (which
  // don't subscribe to job_events) see the session leave the running state.
  // Diff is NOT computed for pipeline sessions — they run in the main repo,
  // not a worktree, so there's nothing to diff against HEAD.
  //
  // Drain any buffered agent:message batch first so trailing chunks land BEFORE
  // agent:complete — otherwise the web sees running=false then receives further
  // messages.
  await flushRelay();
  try {
    await relayAgentEvent(sessionId, "agent:complete", { ...rest });
  } catch {
    /* ignore — relay is best-effort, persistence already happened */
  }

  tracker.complete(sessionId);
  return true;
}

export type HandleNonJobAgentCompleteCtx = {
  tracker: Pick<SessionTracker, "getSession" | "getSnapshot" | "complete">;
  /** Drains the pending agent:message relay batch. */
  flushRelay: () => Promise<void>;
};

/**
 * Non-job branch of `agent:complete` (user-facing sessions): drain the relay
 * batch, compute the worktree branch diff, relay completion (+ diff) to web
 * chat UIs, persist the canonical agent_sessions row (ISS-307), sync agent
 * files to core, and finalize the tracker entry. Moved verbatim from the
 * inline Tauri `agent:complete` listener in use-web-socket.ts.
 */
export async function handleNonJobAgentComplete(
  payload: AgentCompletePayload,
  ctx: HandleNonJobAgentCompleteCtx,
): Promise<void> {
  const { tracker, flushRelay } = ctx;
  const { sessionId, ...rest } = payload;

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
}
