import { request } from "./client";

// ISS-197 — keep parity with packages/core (db/schema.ts) and packages/web
// (features/agent/api.ts). `completed_via_recovery` / `cancelled_stale` are
// non-failure terminal markers from the verify-first retry path.
export type AgentSessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "completed_via_recovery"
  | "cancelled_stale";

export type FailureKind =
  | "transient"
  | "permission"
  | "permanent"
  | "timeout"
  | "unknown";

export interface RecoveryStats {
  totalFailures: number;
  byKind: {
    transient: number;
    permission: number;
    permanent: number;
    timeout: number;
  };
  lastFailureAt: string;
  lastFailureKind: FailureKind;
  autoRetries: number;
}

export async function startAgentSession(
  projectSlug: string,
  promptOrType: string,
  repoPath?: string,
  issueIds?: string[],
  asType?: boolean,
): Promise<{ documentId: string }> {
  const body: any = { projectSlug, repoPath, origin: "desktop", issueIds };
  if (asType) {
    body.type = promptOrType;
  } else {
    body.prompt = promptOrType;
  }
  return request("/agent-sessions/start", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function sendAgentSession(
  sessionId: string,
  message: string,
  claudeSessionId?: string | null,
): Promise<void> {
  await request("/agent-sessions/send", {
    method: "POST",
    body: JSON.stringify({ sessionId, message, claudeSessionId, origin: "desktop" }),
  });
}

/**
 * PATCH the persisted session row on completion (ISS-307).
 *
 * Tauri streams every chunk live via /relay (broadcast only — the relay
 * route does not write to DB). Without a final PATCH the row stays at
 * `status='running'` with `messages=[user only]` forever; if a browser
 * opens the session AFTER the run finished, it sees only the user
 * prompt and no assistant reply because there are no future relay
 * events to subscribe to. PATCH closes that loop by writing the merged
 * messages + status + claude_session_id into the DB.
 */
export async function patchAgentSession(
  sessionId: string,
  patch: {
    status?: "running" | "completed" | "idle" | "failed" | "cancelled";
    messages?: unknown[];
    claudeSessionId?: string | null;
    usage?: unknown;
    diff?: unknown;
  },
): Promise<void> {
  await request(`/agent-sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function relayAgentEvent(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<void> {
  await request(`/agent-sessions/${sessionId}/relay`, {
    method: "POST",
    body: JSON.stringify({ event, data }),
  });
}

export async function relayPromptBuilt(
  requestId: string,
  prompt: string,
  error?: string,
): Promise<void> {
  await request("/agent-sessions/prompt-built", {
    method: "POST",
    body: JSON.stringify({ requestId, prompt: prompt || undefined, error }),
  });
}

export interface PipelineTelemetry {
  autoRetries: number;
  recovered: number;
  failed: number;
  retriesExhausted: number;
}

export async function getPipelineTelemetry(): Promise<PipelineTelemetry> {
  // TODO(iss-275): packages/core only exposes /agent-sessions/:id/pipeline-telemetry
  // (per-session). The sidebar's global counter has no core equivalent yet —
  // short-circuit to zeros until we either aggregate server-side or rewire the
  // sidebar to surface latest-session telemetry.
  return { autoRetries: 0, recovered: 0, failed: 0, retriesExhausted: 0 };
}
