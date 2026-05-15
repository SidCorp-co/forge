import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleJobAssigned, type JobHandlerCtx } from "@/hooks/use-job-handler";

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
    projects: projects as JobHandlerCtx["projects"],
    tracker: { start: vi.fn() },
    jobSessions: new Set<string>(),
    jobAgentSessions: new Map<string, string>(),
  };
}

describe("handleJobAssigned (ISS-115 thin runner)", () => {
  it("happy path: spawns send_chat with the server-provided promptString verbatim", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    mockInvoke.mockResolvedValue(null);
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      {
        jobId: "job-1",
        projectId: "proj-uuid",
        issueId: "ISS-7",
        type: "plan",
        payload: {},
        promptString: "/forge-plan ISS-7",
      },
      ctx,
    );

    expect(ctx.jobSessions.has("job-1")).toBe(true);
    expect(ctx.tracker.start).toHaveBeenCalledWith(
      "job-1",
      "demo",
      "/forge-plan ISS-7",
      { repoPath: "/repos/demo", agentSessionId: undefined },
    );
    expect(mockInvoke).toHaveBeenCalledWith("send_chat", expect.objectContaining({
      repoPath: "/repos/demo",
      message: "/forge-plan ISS-7",
      sessionId: "job-1",
      claudeSessionId: null,
      projectSlug: "demo",
    }));
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it("forwards a non-pipeline promptString verbatim (no client-side mapping)", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    mockInvoke.mockResolvedValue(null);
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      {
        jobId: "job-2",
        projectId: "p",
        issueId: "ISS-9",
        type: "custom",
        payload: {},
        promptString: "/custom-skill ISS-9",
      },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledWith("send_chat", expect.objectContaining({
      message: "/custom-skill ISS-9",
    }));
  });

  it("falls back to payload.promptString when the top-level field is absent", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    mockInvoke.mockResolvedValue(null);
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      {
        jobId: "job-3",
        projectId: "p",
        issueId: "ISS-7",
        type: "plan",
        payload: { promptString: "/forge-plan ISS-7" },
      },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledWith("send_chat", expect.objectContaining({
      message: "/forge-plan ISS-7",
    }));
  });

  it("fails permanently with missing_prompt_string when neither field is present", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      { jobId: "job-no-prompt", projectId: "p", issueId: "ISS-7", type: "plan", payload: {} },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-no-prompt", "missing_prompt_string");
    expect(mockInvoke).not.toHaveBeenCalledWith("send_chat", expect.anything());
  });

  it("no-op when jobId is missing (defensive)", async () => {
    const ctx = makeCtx({});
    await handleJobAssigned(undefined as never, ctx);
    await handleJobAssigned({ projectId: "p", type: "plan", payload: {} } as never, ctx);
    expect(mockResolveProjectSlug).not.toHaveBeenCalled();
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it("fails the job when project slug cannot be resolved", async () => {
    mockResolveProjectSlug.mockRejectedValue(new Error("nope"));
    const ctx = makeCtx({});

    await handleJobAssigned(
      {
        jobId: "job-1",
        projectId: "missing",
        type: "plan",
        payload: {},
        promptString: "/forge-plan ISS-7",
      },
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
      {
        jobId: "job-1",
        projectId: "p",
        type: "plan",
        payload: {},
        promptString: "/forge-plan ISS-7",
      },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("no repoPath"));
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
      {
        jobId: "job-1",
        projectId: "p",
        type: "plan",
        payload: {},
        promptString: "/forge-plan ISS-7",
      },
      ctx,
    );

    expect(ctx.jobSessions.has("job-1")).toBe(true);
    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("send_chat failed"));
  });

  it("fails the job immediately when running outside Tauri (browser fallback has no agent listeners)", async () => {
    mockIsTauri = false;
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      {
        jobId: "job-1",
        projectId: "p",
        type: "plan",
        payload: {},
        promptString: "/forge-plan ISS-7",
      },
      ctx,
    );

    expect(mockFailJob).toHaveBeenCalledWith("job-1", expect.stringContaining("browser mode"));
    expect(mockResolveProjectSlug).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(ctx.jobSessions.has("job-1")).toBe(false);
  });

  it("populates jobAgentSessions when agentSessionId is provided", async () => {
    mockResolveProjectSlug.mockResolvedValue("demo");
    mockInvoke.mockResolvedValue(null);
    const ctx = makeCtx({ demo: { repoPath: "/repos/demo" } });

    await handleJobAssigned(
      {
        jobId: "job-as",
        projectId: "p",
        issueId: "ISS-7",
        type: "plan",
        payload: {},
        promptString: "/forge-plan ISS-7",
        agentSessionId: "sess-abc",
      },
      ctx,
    );

    expect(ctx.jobAgentSessions.get("job-as")).toBe("sess-abc");
  });
});
