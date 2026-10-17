import {
  FAILURE_CAUSES,
  FAILURE_CAUSE_PRESENTATION,
  LEGACY_NEUTRAL_REASONS,
} from "@forge/contracts/failure-causes";
import { describe, expect, it } from "vitest";
import {
  FAILURE_REASON_LABEL,
  failureReasonAction,
  failureReasonLabel,
  STALLED_THRESHOLD_MS,
  deriveLiveness,
  deriveSessionDisplayStatus,
  isAwaitingReply,
  isInteractiveSession,
  isJobDriven,
  sessionKind,
  sessionStep,
  statusToChip,
  classifySessionOutcome,
  isRealFailure,
  type SessionRow,
} from "./types";

const NOW = Date.parse("2026-06-04T12:00:00.000Z");

/** Build a minimal `running` SessionRow whose last heartbeat is `agoMs` old. */
function running(agoMs: number, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess",
    projectId: "proj",
    userId: null,
    deviceId: null,
    pipelineRunId: null,
    title: null,
    repoPath: null,
    status: "running",
    usage: null,
    metadata: { type: "pipeline" },
    failureReason: null,
    dispatchedAt: null,
    startedAt: null,
    lastHeartbeatAt: new Date(NOW - agoMs).toISOString(),
    createdAt: new Date(NOW - agoMs).toISOString(),
    updatedAt: new Date(NOW - agoMs).toISOString(),
    ...over,
  };
}

describe("deriveLiveness", () => {
  it("is alive just under the stale threshold (59s)", () => {
    expect(deriveLiveness(running(59_000), NOW).state).toBe("alive");
  });

  // ISS-1228 round 9: the countdown and the "past" line count to the silence after which core ends
  // this session, which core states on the row; the screen holds no number of its own.
  const PIPELINE_LIMIT = 3 * 60_000;
  const RUN_LIMIT = 10 * 60_000;

  it("is stale just over the stale threshold (61s) with a countdown to core's limit", () => {
    const r = deriveLiveness(running(61_000, { silenceLimitMs: PIPELINE_LIMIT }), NOW);
    expect(r.state).toBe("stale");
    expect(r.reapInMs).toBe(PIPELINE_LIMIT - 61_000);
  });

  it("is still stale just under core's limit (179s of 180s)", () => {
    expect(deriveLiveness(running(179_000, { silenceLimitMs: PIPELINE_LIMIT }), NOW).state).toBe("stale");
  });

  it("is reaping past core's limit (181s of 180s)", () => {
    const r = deriveLiveness(running(181_000, { silenceLimitMs: PIPELINE_LIMIT }), NOW);
    expect(r.state).toBe("reaping");
    expect(r.reapInMs).toBe(0);
  });

  it("counts a run session to its own ten minutes, not to another kind's three", () => {
    const r = deriveLiveness(running(4 * 60_000, { kind: "run_session", silenceLimitMs: RUN_LIMIT }), NOW);
    expect(r.state).toBe("stale");
    expect(r.reapInMs).toBe(6 * 60_000);
    expect(deriveLiveness(running(RUN_LIMIT + 1_000, { silenceLimitMs: RUN_LIMIT }), NOW).state).toBe("reaping");
  });

  it("states no countdown and never past where core ends the session on no silence", () => {
    for (const silenceLimitMs of [null, undefined]) {
      const r = deriveLiveness(running(60 * 60_000, { silenceLimitMs }), NOW);
      expect(r.state).toBe("stale");
      expect(r.reapInMs).toBeNull();
    }
  });

  it("calls a session past core's limit even inside the quiet line, where core's limit is shorter", () => {
    const r = deriveLiveness(running(45_000, { silenceLimitMs: 30_000 }), NOW);
    expect(r).toEqual({ state: "reaping", sinceHeartbeatMs: 45_000, reapInMs: 0 });
    expect(deriveLiveness(running(30_000, { silenceLimitMs: 30_000 }), NOW).state).toBe("alive");
  });

  it("treats the exact thresholds as the lower band (boundaries inclusive)", () => {
    expect(deriveLiveness(running(STALLED_THRESHOLD_MS), NOW).state).toBe("alive");
    expect(deriveLiveness(running(PIPELINE_LIMIT, { silenceLimitMs: PIPELINE_LIMIT }), NOW).state).toBe("stale");
  });

  it("returns na for an interactive chat session even when long-running", () => {
    const chat = running(10 * 60_000, { metadata: { type: "interactive" } });
    expect(deriveLiveness(chat, NOW).state).toBe("na");
  });

  it("returns na for non-running sessions", () => {
    expect(deriveLiveness(running(999_000, { status: "completed" }), NOW).state).toBe("na");
    expect(deriveLiveness(running(999_000, { status: "queued" }), NOW).state).toBe("na");
  });

  it("is alive when no heartbeat signal exists at all", () => {
    const r = deriveLiveness(
      running(0, { lastHeartbeatAt: null, startedAt: null, updatedAt: null as unknown as string }),
      NOW,
    );
    expect(r.state).toBe("alive");
  });
});

describe("deriveSessionDisplayStatus (single-sourced on deriveLiveness)", () => {
  it("maps alive → running, stale/reaping → stalled", () => {
    expect(deriveSessionDisplayStatus(running(59_000), NOW)).toBe("running");
    expect(deriveSessionDisplayStatus(running(61_000), NOW)).toBe("stalled");
    expect(deriveSessionDisplayStatus(running(181_000), NOW)).toBe("stalled");
  });

  it("never marks an interactive chat stalled", () => {
    const chat = running(10 * 60_000, { metadata: { type: "interactive" } });
    expect(deriveSessionDisplayStatus(chat, NOW)).toBe("running");
  });

  it("passes through non-running statuses", () => {
    expect(deriveSessionDisplayStatus(running(0, { status: "failed" }), NOW)).toBe("failed");
  });

  // ISS-1228 round 8: what the box says of the session decides between Working and Blocked; silence
  // still outranks both, since nobody has heard either for a minute.
  const report = (work: string) => ({
    incarnation: "live",
    work,
    blockerKind: "human",
    waitingOn: "approve the restore",
    observedAt: new Date(NOW - 5_000).toISOString(),
    since: new Date(NOW - 5_000).toISOString(),
  });
  it("calls a running session its box reports blocked blocked, and a quiet one quiet", () => {
    expect(deriveSessionDisplayStatus(running(5_000, { report: report("blocked") }), NOW)).toBe("blocked");
    expect(deriveSessionDisplayStatus(running(5_000, { report: report("runnable") }), NOW)).toBe("running");
    expect(deriveSessionDisplayStatus(running(90_000, { report: report("blocked") }), NOW)).toBe("stalled");
    expect(deriveSessionDisplayStatus(running(0, { status: "failed", report: report("blocked") }), NOW)).toBe("failed");
  });

  it("gives a blocked session the blocked chip, never the running one", () => {
    expect(statusToChip("blocked")).toBe("blocked");
  });
});

describe("statusToChip (ISS-322 — cancelled_stale is neutral, not red)", () => {
  it("maps cancelled_stale → swept (neutral), NOT zombie (red)", () => {
    expect(statusToChip("cancelled_stale")).toBe("swept");
  });

  it("keeps a LIVE stalled session as zombie (attention)", () => {
    expect(statusToChip("stalled")).toBe("zombie");
  });

  it("keeps genuine + success states unchanged", () => {
    expect(statusToChip("failed")).toBe("failed");
    expect(statusToChip("completed")).toBe("done");
    expect(statusToChip("completed_via_recovery")).toBe("done");
    expect(statusToChip("running")).toBe("running");
  });
});

describe("classifySessionOutcome (ISS-322 four-bucket classifier)", () => {
  it("classifies clean completions as success/done", () => {
    expect(classifySessionOutcome("completed").bucket).toBe("success");
    expect(classifySessionOutcome("completed_via_recovery").statusKey).toBe("done");
  });

  it("classifies cancelled_stale as a neutral swept cleanup", () => {
    const o = classifySessionOutcome("cancelled_stale");
    expect(o.bucket).toBe("swept");
    expect(o.statusKey).toBe("swept");
    expect(o.tooltip).toMatch(/not a failure/i);
  });

  it("classifies a genuine job_failed as a red failure", () => {
    const o = classifySessionOutcome("failed", "job_failed");
    expect(o.bucket).toBe("failed");
    expect(o.statusKey).toBe("failed");
  });

  it("classifies a failed row with no reason as a red failure (don't hide it)", () => {
    expect(classifySessionOutcome("failed", null).bucket).toBe("failed");
    expect(classifySessionOutcome("failed").statusKey).toBe("failed");
  });

  it("demotes lifecycle/capacity cancels on a failed row to neutral swept", () => {
    for (const reason of [
      "queue_timeout",
      "heartbeat_timeout",
      "no_worker_online",
      "user_cancelled",
      "issue_busy",
      "runner_full",
    ]) {
      const o = classifySessionOutcome("failed", reason);
      expect(o.bucket, reason).toBe("swept");
      expect(o.statusKey, reason).toBe("swept");
    }
  });

  it("treats legacy pipeline_* / migration cleanup reasons as benign cleanup", () => {
    for (const reason of [
      "pipeline_completed",
      "pipeline_failed",
      "pipeline_cancelled",
      "migration_zombie_cleanup",
    ]) {
      const o = classifySessionOutcome("failed", reason);
      expect(o.bucket, reason).toBe("cleanup");
      expect(o.statusKey, reason).toBe("swept");
    }
  });

  it("ISS-877: paints every real cause red and names it, instead of a bare Failed", () => {
    for (const reason of [
      "provider_spend_cap",
      "provider_auth_expired",
      "provider_subscription_disabled",
      "agent_startup_failed",
      "agent_skill_missing",
      "workspace_disk_full",
      "workspace_preflight_failed",
      "runner_unreachable",
      "session_lost",
      "unclassified",
    ]) {
      const o = classifySessionOutcome("failed", reason);
      expect(o.bucket, reason).toBe("failed");
      expect(o.statusKey, reason).toBe("failed");
      expect(o.label, reason).not.toBe("Failed");
      expect(o.tooltip, reason).not.toBe("");
    }
  });

  it("ISS-877: keeps lifecycle conclusions and the residency bound neutral", () => {
    for (const reason of ["orphan_under_terminal_run", "manual_ops_stale_chat_schedule"]) {
      expect(classifySessionOutcome("failed", reason).statusKey, reason).toBe("swept");
    }
    expect(classifySessionOutcome("failed", "residency_expired").bucket).toBe("swept");
  });

  it("ISS-877: every cause core can write has a label and an action", () => {
    for (const cause of FAILURE_CAUSES) {
      expect(failureReasonLabel(cause), cause).toBeTruthy();
      expect(failureReasonAction(cause), cause).toBeTruthy();
    }
  });

  it("ISS-1228: on a page whose button says Rerun, no remedy tells the reader to press Retry", () => {
    for (const cause of FAILURE_CAUSES) {
      const action = failureReasonAction(cause, "Rerun") ?? "";
      expect(action, cause).not.toMatch(/\bRetry\b/);
      expect(action, cause).toBe(failureReasonAction(cause)?.replace(/\bRetry\b/g, "Rerun"));
    }
  });

  it("ISS-877: every cause reads the same way here as it does to the failure metric", () => {
    for (const cause of FAILURE_CAUSES) {
      const bucket = classifySessionOutcome("failed", cause).bucket;
      expect(bucket, cause).toBe(
        FAILURE_CAUSE_PRESENTATION[cause] === "failure" ? "failed" : FAILURE_CAUSE_PRESENTATION[cause],
      );
    }
  });

  it("ISS-877: a dispatcher skip reason on an old row reads neutral, not as a raw token", () => {
    for (const reason of LEGACY_NEUTRAL_REASONS) {
      expect(classifySessionOutcome("failed", reason).statusKey, reason).toBe("swept");
      expect(failureReasonLabel(reason), reason).toBeTruthy();
    }
  });

  it("ISS-877: a legacy job_failed row reads as unclassified, not as a diagnosis", () => {
    expect(FAILURE_REASON_LABEL.job_failed).toBe("Unclassified");
    expect(classifySessionOutcome("failed", "job_failed").label).toBe("Unclassified");
  });

  it("ISS-877: the pre-rename hyphen spelling still renders", () => {
    expect(FAILURE_REASON_LABEL["ws-publish-failed"]).toBe(
      FAILURE_REASON_LABEL.ws_publish_failed,
    );
  });

  it("returns active (deferring to statusToChip) for non-terminal states", () => {
    expect(classifySessionOutcome("running").bucket).toBe("active");
    expect(classifySessionOutcome("stalled").statusKey).toBe("zombie");
    expect(classifySessionOutcome("queued").statusKey).toBe("queued");
  });
});

describe("isRealFailure (only genuine failures count as attention)", () => {
  it("is true for an unclassified row (legacy or current) and an unknown-reason row", () => {
    expect(isRealFailure("failed", "job_failed")).toBe(true);
    expect(isRealFailure("failed", "unclassified")).toBe(true);
    expect(isRealFailure("failed", null)).toBe(true);
  });

  it("ISS-877: is true for a provider/agent/workspace cause — those need attention", () => {
    expect(isRealFailure("failed", "provider_spend_cap")).toBe(true);
    expect(isRealFailure("failed", "agent_startup_failed")).toBe(true);
    expect(isRealFailure("failed", "workspace_disk_full")).toBe(true);
  });

  it("is false for swept / cleanup / success / cancelled_stale", () => {
    expect(isRealFailure("failed", "user_cancelled")).toBe(false);
    expect(isRealFailure("failed", "pipeline_completed")).toBe(false);
    expect(isRealFailure("cancelled_stale")).toBe(false);
    expect(isRealFailure("completed")).toBe(false);
  });
});

describe("sessionKind / isInteractiveSession", () => {
  it("reads the species off the column", () => {
    expect(sessionKind({ kind: "master", metadata: null })).toBe("master");
    expect(sessionKind({ kind: "run_session", metadata: null })).toBe("run_session");
    expect(sessionKind({ kind: "pipeline", metadata: null })).toBe("pipeline");
    expect(sessionKind({ kind: "pm", metadata: null })).toBe("pm");
    expect(sessionKind({ kind: "chat", metadata: null })).toBe("chat");
  });

  it("does not collapse a master or a run session into a chat", () => {
    expect(isInteractiveSession({ kind: "master", metadata: null })).toBe(false);
    expect(isInteractiveSession({ kind: "run_session", metadata: null })).toBe(false);
  });

  it("groups the two job-driven kinds without merging their names", () => {
    expect(isJobDriven({ kind: "pipeline", metadata: null })).toBe(true);
    expect(isJobDriven({ kind: "pm", metadata: null })).toBe(true);
    expect(isJobDriven({ kind: "chat", metadata: null })).toBe(false);
  });

  // A deployment older than the column sends no `kind`.
  it("falls back to the old reading for a row served without a kind", () => {
    expect(sessionKind({ metadata: { type: "pipeline" } })).toBe("pipeline");
    expect(sessionKind({ metadata: { type: "pm" } })).toBe("pm");
    expect(sessionKind({ metadata: { type: "master" } })).toBe("master");
    expect(sessionKind({ metadata: { type: "run_session" } })).toBe("run_session");
    expect(sessionKind({ metadata: { type: "agent" } })).toBe("chat");
    expect(sessionKind({ metadata: null })).toBe("chat");
  });

  it("ignores a kind outside the vocabulary rather than rendering it", () => {
    expect(sessionKind({ kind: "wave" as never, metadata: null })).toBe("chat");
  });
});

describe("isAwaitingReply (ISS-664 — 'waiting for me' signal)", () => {
  it("is true for an idle interactive chat", () => {
    expect(isAwaitingReply({ status: "idle", metadata: { type: "agent" } })).toBe(true);
    expect(isAwaitingReply({ status: "idle", metadata: { type: "interactive" } })).toBe(true);
  });

  it("is false for an idle PIPELINE session — that's waiting on capacity, not the owner", () => {
    expect(isAwaitingReply({ status: "idle", metadata: { type: "pipeline" } })).toBe(false);
    expect(isAwaitingReply({ status: "idle", metadata: { type: "pm" } })).toBe(false);
  });

  it("is false for an idle master or run session, which await nobody's reply", () => {
    expect(isAwaitingReply({ status: "idle", kind: "master", metadata: null })).toBe(false);
    expect(isAwaitingReply({ status: "idle", kind: "run_session", metadata: null })).toBe(false);
  });

  it("is false for a running chat (agent still working, not awaiting reply yet)", () => {
    expect(isAwaitingReply({ status: "running", metadata: { type: "agent" } })).toBe(false);
  });

  it("is false for a terminal chat", () => {
    expect(isAwaitingReply({ status: "completed", metadata: { type: "agent" } })).toBe(false);
  });
});

describe("sessionStep — the step a session recorded, or none (ISS-999)", () => {
	const meta = (over: Record<string, unknown>) =>
		over as unknown as Parameters<typeof sessionStep>[0];

	it("names `drive` in the dashboard's words, not as one of the seven staged names", () => {
		expect(sessionStep(meta({ type: "pipeline", step: "drive" }))).toBe("Issue work");
	});

	it("says a staged step it has no words for is unrecognised, showing the word that was recorded", () => {
		expect(sessionStep(meta({ step: "verify" }))).toBe("Unrecognised work (verify)");
		expect(sessionStep(meta({ step: "code" }))).toBe("Unrecognised work (code)");
	});

	it("falls back to `stage` where only that was recorded", () => {
		expect(sessionStep(meta({ stage: "review" }))).toBe("Unrecognised work (review)");
	});

	it("passes a blank `step` over in favour of a recorded `stage`", () => {
		expect(sessionStep(meta({ step: " ", stage: "review" }))).toBe("Unrecognised work (review)");
		expect(sessionStep(meta({ step: "", stage: "review" }))).toBe("Unrecognised work (review)");
	});

	it("names no step for a value that is not a string", () => {
		expect(sessionStep(meta({ step: { name: "drive" } }))).toBeNull();
		expect(sessionStep(meta({ step: 7, stage: "plan" }))).toBe("Unrecognised work (plan)");
		expect(sessionStep(meta({ step: null, stage: null }))).toBeNull();
	});

	it("names no step for a session that recorded none, and never reads `type` as one", () => {
		expect(sessionStep(meta({ type: "pipeline" }))).toBeNull();
		expect(sessionStep(meta({ step: "  " }))).toBeNull();
		expect(sessionStep(meta({}))).toBeNull();
		expect(sessionStep(null)).toBeNull();
	});
});
