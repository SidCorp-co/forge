import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildJobPrompt, handleJobAssigned, type JobHandlerCtx } from "@/hooks/use-job-handler";

const mockInvoke = vi.fn();
let mockIsTauri = true;
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  get isTauri() { return mockIsTauri; },
}));

const mockResolveProjectSlug = vi.fn();
const mockFailJob = vi.fn();
vi.mock("@/lib/api", () => ({
  failJob: (...args: unknown[]) => mockFailJob(...args),
  resolveProjectSlug: (...args: unknown[]) => mockResolveProjectSlug(...args),
}));

beforeEach(() => {
  mockInvoke.mockReset();
  mockResolveProjectSlug.mockReset();
  mockFailJob.mockReset();
  mockIsTauri = true;
});

function makeCtx(projects: Record<string, { repoPath?: string; mcpServers?: Record<string, unknown> }>): JobHandlerCtx & { tracker: { start: ReturnType<typeof vi.fn> } } {
  return {
    config: { projects },
    tracker: { start: vi.fn() },
    jobSessions: new Set<string>(),
  };
}

describe("buildJobPrompt", () => {
  it("returns /forge-<type> <issueId> for supported types", () => {
    expect(buildJobPrompt("plan", { issueId: "ISS-7" })).toBe("/forge-plan ISS-7");
    expect(buildJobPrompt("code", { issueId: "ISS-7" })).toBe("/forge-code ISS-7");
    expect(buildJobPrompt("review", { issueId: "ISS-7" })).toBe("/forge-review ISS-7");
    expect(buildJobPrompt("fix", { issueId: "ISS-7" })).toBe("/forge-fix ISS-7");
    expect(buildJobPrompt("triage", { issueId: "ISS-7" })).toBe("/forge-triage ISS-7");
  });
  it("returns null when issueId is missing", () => {
    expect(buildJobPrompt("plan", {})).toBeNull();
    expect(buildJobPrompt("plan", undefined)).toBeNull();
  });
  it("returns null for unsupported job types", () => {
    expect(buildJobPrompt("deploy", { issueId: "ISS-7" })).toBeNull();
  });
});

describe("handleJobAssigned", () => {
  it("happy path: resolves slug, marks session, invokes send_chat with sessionId=jobId", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    mockInvoke.mockResolvedValue(null);
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      { jobId: "job-1", projectId: "proj-uuid", type: "plan", payload: { issueId: "ISS-7" } },
      ctx,
    );

    expect(ctx.jobSessions.has("job-1")).toBe(true);
    expect(ctx.tracker.start).toHaveBeenCalledWith("job-1", "demo", "/forge-plan ISS-7", { repoPath: "/repos/demo" });
    expect(mockInvoke).toHaveBeenCalledWith("send_chat", expect.objectContaining({
      repoPath: "/repos/demo",
      message: "/forge-plan ISS-7",
      sessionId: "job-1",
      claudeSessionId: null,
      projectSlug: "demo",
    }));
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it("no-op when jobId is missing (defensive)", async () => {
    const ctx = makeCtx({});
    await handleJobAssigned(undefined as any, ctx);
    await handleJobAssigned({ projectId: "p", type: "plan", payload: { issueId: "x" } } as any, ctx);
    expect(mockResolveProjectSlug).not.toHaveBeenCalled();
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it("fails the job when project slug cannot be resolved", async () => {
    mockResolveProjectSlug.mockRejectedValue(new Error("nope"));
    const ctx = makeCtx({});

    await handleJobAssigned(
      { jobId: "job-1", projectId: "missing", type: "plan", payload: { issueId: "ISS-7" } },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("project not found"));
    expect(mockInvoke).not.toHaveBeenCalledWith("send_chat", expect.anything());
    expect(ctx.jobSessions.has("job-1")).toBe(false);
  });

  it("fails the job when project has no repoPath configured locally", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    const ctx = makeCtx({ demo: {} });

    await handleJobAssigned(
      { jobId: "job-1", projectId: "p", type: "plan", payload: { issueId: "ISS-7" } },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("no repoPath"));
    expect(mockInvoke).not.toHaveBeenCalledWith("send_chat", expect.anything());
  });

  it("fails the job for unsupported job type", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      { jobId: "job-1", projectId: "p", type: "deploy", payload: { issueId: "ISS-7" } },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("unsupported job type"));
    expect(mockInvoke).not.toHaveBeenCalledWith("send_chat", expect.anything());
  });

  it("on send_chat failure: keeps session marker (so late agent:* events don't leak to user relay) and posts failJob", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "send_chat") throw new Error("CLI not found");
      return null;
    });
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      { jobId: "job-1", projectId: "p", type: "plan", payload: { issueId: "ISS-7" } },
      ctx,
    );

    // Marker must persist — see comment in use-job-handler.ts and the
    // matching invariant in use-web-socket.ts agent:complete branch.
    expect(ctx.jobSessions.has("job-1")).toBe(true);
    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("send_chat failed"));
  });

  it("fails the job immediately when running outside Tauri (browser fallback has no agent listeners)", async () => {
    mockIsTauri = false;
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      { jobId: "job-1", projectId: "p", type: "plan", payload: { issueId: "ISS-7" } },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("browser mode"));
    expect(mockResolveProjectSlug).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(ctx.jobSessions.has("job-1")).toBe(false);
  });
});
