import { request } from "./client";

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

export async function registerDesktop(deviceId: string): Promise<void> {
  await request("/agent-sessions/desktop/register", {
    method: "POST",
    body: JSON.stringify({ deviceId }),
  });
}

export async function unregisterDesktop(deviceId: string): Promise<void> {
  await request("/agent-sessions/desktop/unregister", {
    method: "POST",
    body: JSON.stringify({ deviceId }),
  });
}

export async function registerDevice(deviceId: string, name: string): Promise<{ projectsRoot?: string | null; projectPaths?: Record<string, string> | null }> {
  return request("/devices/register", {
    method: "POST",
    body: JSON.stringify({ deviceId, name }),
  });
}

export async function setDeviceProjectPath(deviceId: string, projectSlug: string, repoPath: string): Promise<void> {
  await request("/devices/project-path", {
    method: "PUT",
    body: JSON.stringify({ deviceId, projectSlug, repoPath }),
  });
}

export async function setDeviceProjectsRoot(deviceId: string, projectsRoot: string | null): Promise<void> {
  await request("/devices/projects-root", {
    method: "PUT",
    body: JSON.stringify({ deviceId, projectsRoot }),
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
  // TODO(iss-275): forge/core only exposes /agent-sessions/:id/pipeline-telemetry
  // (per-session). The sidebar's global counter has no core equivalent yet —
  // short-circuit to zeros until we either aggregate server-side or rewire the
  // sidebar to surface latest-session telemetry.
  return { autoRetries: 0, recovered: 0, failed: 0, retriesExhausted: 0 };
}
