import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy on the core REST calls the job-completion branch fires. `handleAgentComplete`
// is a pure function (deps injected via ctx), so this is the only module-level
// dependency that must be mocked — importing use-web-socket pulls @/lib/api at
// module-eval time (the module-level SessionTracker references patchAgentSession).
const completeJob = vi.fn(async () => undefined);
const patchAgentSession = vi.fn(async () => undefined);
const createUsageRecord = vi.fn(async () => undefined);
const relayAgentEvent = vi.fn(async () => undefined);

// use-web-socket imports Sentry at module-eval; the real module pulls the
// @forge/observability workspace package, which isn't needed here.
vi.mock("@/lib/sentry", () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  completeJob: (...args: unknown[]) => completeJob(...args),
  patchAgentSession: (...args: unknown[]) => patchAgentSession(...args),
  createUsageRecord: (...args: unknown[]) => createUsageRecord(...args),
  relayAgentEvent: (...args: unknown[]) => relayAgentEvent(...args),
  // Unused by handleAgentComplete but imported by the module:
  getProject: vi.fn(),
  getAgents: vi.fn(),
  syncAgentFiles: vi.fn(),
  postJobEvents: vi.fn(),
}));

import { handleAgentComplete, type HandleAgentCompleteCtx } from "@/hooks/use-web-socket";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function makeCtx(overrides?: Partial<HandleAgentCompleteCtx>): HandleAgentCompleteCtx {
  return {
    jobSessionsRef: { current: new Set<string>([JOB_ID]) },
    cancelledJobsRef: { current: new Set<string>() },
    jobAgentSessionsRef: { current: new Map<string, string>() },
    tracker: { getSnapshot: vi.fn(() => undefined), complete: vi.fn() },
    flushJobEvents: vi.fn(async () => undefined),
    flushRelay: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("handleAgentComplete", () => {
  beforeEach(() => {
    completeJob.mockClear();
    patchAgentSession.mockClear();
    createUsageRecord.mockClear();
    relayAgentEvent.mockClear();
  });

  it("POSTs /complete with exitCode 0 on a clean agent:complete (DONE, no error)", async () => {
    const ctx = makeCtx();

    const handled = await handleAgentComplete(
      { sessionId: JOB_ID, claudeSessionId: "claude-abc", error: undefined },
      ctx,
    );

    expect(handled).toBe(true);
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(completeJob).toHaveBeenCalledWith(JOB_ID, 0, { error: null });
    // The job_event batch must drain before /complete moves the job terminal.
    expect(ctx.flushJobEvents).toHaveBeenCalledTimes(1);
    // Mirrors completion to web chat UIs.
    expect(relayAgentEvent).toHaveBeenCalledWith(JOB_ID, "agent:complete", {
      claudeSessionId: "claude-abc",
    });
    expect(ctx.tracker.complete).toHaveBeenCalledWith(JOB_ID);
  });

  it("maps a cancelled job to exitCode -1", async () => {
    const ctx = makeCtx({ cancelledJobsRef: { current: new Set<string>([JOB_ID]) } });

    const handled = await handleAgentComplete({ sessionId: JOB_ID }, ctx);

    expect(handled).toBe(true);
    expect(completeJob).toHaveBeenCalledWith(JOB_ID, -1, { error: null });
  });

  it("maps an errored job to exitCode 1 and forwards the error", async () => {
    const ctx = makeCtx();

    const handled = await handleAgentComplete(
      { sessionId: JOB_ID, error: "boom" },
      ctx,
    );

    expect(handled).toBe(true);
    expect(completeJob).toHaveBeenCalledWith(JOB_ID, 1, { error: "boom" });
  });

  it("returns false and does NOT POST /complete for a non-job session", async () => {
    const ctx = makeCtx({ jobSessionsRef: { current: new Set<string>() } });

    const handled = await handleAgentComplete({ sessionId: "user-session" }, ctx);

    expect(handled).toBe(false);
    expect(completeJob).not.toHaveBeenCalled();
    expect(ctx.flushJobEvents).not.toHaveBeenCalled();
  });
});
