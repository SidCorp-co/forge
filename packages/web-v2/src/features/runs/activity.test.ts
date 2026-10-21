// The feed's whole reason to exist is that N failures must not read as N
// identical lines, so the load-bearing cases are: same cause N times collapses
// and COUNTS; two different causes never collapse; `unclassified` is rendered
// rather than hidden; and a live attempt still says something.

import { describe, expect, it } from "vitest";
import {
  type ActivityEntry,
  deriveActivityFeed,
  distinctCauseCount,
  filterActivity,
  isFailureEntry,
} from "./activity";
import type { PipelineRunAttempt } from "./types";

function attempt(over: Partial<PipelineRunAttempt> = {}): PipelineRunAttempt {
  return {
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    jobType: "code",
    status: "failed",
    attempts: 1,
    retryOf: null,
    deviceId: "dev-1",
    deviceName: "ubuntu5",
    failureReason: null,
    failureCause: null,
    failureDetail: null,
    failureKind: null,
    failureAction: null,
    queuedAt: "2026-08-30T10:00:00.000Z",
    startedAt: "2026-08-30T10:00:05.000Z",
    ranAt: "2026-08-30T10:00:06.000Z",
    finishedAt: "2026-08-30T10:01:00.000Z",
    autoRetry: null,
    takenBy: null,
    ...over,
  };
}

describe("deriveActivityFeed", () => {
  it("collapses 16 identical spend-cap deaths into one counted line", () => {
    const rows = Array.from({ length: 16 }, () =>
      attempt({ failureCause: "provider_spend_cap", failureDetail: "org monthly cap reached" }),
    );

    const feed = deriveActivityFeed(rows);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.repeats).toBe(16);
    expect(feed[0]?.positions).toHaveLength(16);
    expect(feed[0]?.outcome).toBe("Spend limit reached");
    expect(feed[0]?.verb).toBe("Retried");
  });

  it("keeps two different causes as two lines — the point of the issue", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "provider_spend_cap" }),
      attempt({ failureCause: "workspace_disk_full" }),
    ]);

    expect(feed).toHaveLength(2);
    expect(feed.map((e) => e.outcome)).toEqual(["Spend limit reached", "Runner disk full"]);
    expect(distinctCauseCount(feed)).toBe(2);
  });

  it("does not collapse the same cause across different runners", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "runner_unreachable", deviceName: "ubuntu5" }),
      attempt({ failureCause: "runner_unreachable", deviceName: "ubuntu6" }),
    ]);

    expect(feed).toHaveLength(2);
    expect(feed.map((e) => e.device)).toEqual(["ubuntu5", "ubuntu6"]);
  });

  it.each([
    ["never started, then ran", [null, "2026-08-30T10:00:05.000Z"]],
    ["ran, then never started", ["2026-08-30T10:00:05.000Z", null]],
  ])("keeps two lost-box attempts apart when one %s, the remedy on the latest alone", (_n, starts) => {
    const feed = deriveActivityFeed(
      starts.map((ranAt) => attempt({ failureCause: "runner_unreachable", ranAt })),
    );

    expect(feed).toHaveLength(2);
    // The earlier attempt core already sent again asks nothing of a person (round 19).
    expect(feed[0]?.note).toBe("Core already sent it again, so nothing is asked of you.");
    expect(feed[0]?.action).toBeNull();
    expect(feed[1]?.action).toEqual(
      starts[1] ? expect.stringContaining("stopped answering") : "Check that ubuntu5 is online and its runner is running.",
    );
  });

  it("re-opens a group when a third attempt differs from the collapsed pair", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "provider_spend_cap" }),
      attempt({ failureCause: "provider_spend_cap" }),
      attempt({ failureCause: "agent_killed" }),
      attempt({ failureCause: "provider_spend_cap" }),
    ]);

    expect(feed.map((e) => [e.outcome, e.repeats])).toEqual([
      ["Spend limit reached", 2],
      ["Agent killed", 1],
      ["Spend limit reached", 1],
    ]);
  });

  it("renders unclassified as a first-class line, never a blank", () => {
    const feed = deriveActivityFeed([attempt({ failureCause: "job_failed" })]);

    expect(feed[0]?.cause).toBe("unclassified");
    expect(feed[0]?.outcome).toBe("Unclassified");
    expect(isFailureEntry(feed[0] as ActivityEntry)).toBe(true);
  });

  it("classifies a failed attempt that left no cause at all rather than going quiet", () => {
    const feed = deriveActivityFeed([attempt({ failureCause: null, failureReason: null })]);

    expect(feed[0]?.cause).toBe("unclassified");
    expect(feed[0]?.action).toBeTruthy();
  });

  it("says something for an attempt still in flight — silence is a rendered state", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "queued", finishedAt: null, startedAt: null, failureCause: null }),
      attempt({ status: "running", finishedAt: null, failureCause: null }),
    ]);

    expect(feed.map((e) => e.outcome)).toEqual([
      "Queued — no box has taken it yet",
      "Still running",
    ]);
    expect(feed.every((e) => e.open)).toBe(true);
    expect(feed.every((e) => e.tone === "open")).toBe(true);
  });

  it("keeps a benign cleanup out of the red — a cascade is not a failure", () => {
    const feed = deriveActivityFeed([attempt({ failureCause: "pipeline_cancelled" })]);

    expect(feed[0]?.tone).toBe("cleanup");
    expect(isFailureEntry(feed[0] as ActivityEntry)).toBe(false);
    expect(distinctCauseCount(feed)).toBe(0);
  });

  it("reads a dispatcher skip reason neutral instead of counting it as a death", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "cancelled", failureReason: "runner_full", failureCause: null }),
    ]);

    expect(feed[0]?.cause).toBeNull();
    expect(feed[0]?.outcome).toBe("Runner at capacity");
    expect(feed[0]?.tone).toBe("swept");
  });

  // ISS-1228 round 18 repair: the drawer printed core's own reason text, "dispatch never claimed by a
  // runner (no ack / no started event within grace window)", under a row that named box-a.
  it("prints none of the reason text core recorded for engineers", () => {
    const [entry] = deriveActivityFeed([
      attempt({
        failureCause: "heartbeat_timeout",
        failureDetail: "master-reaper: heartbeat stopped",
        failureReason: "usage/session limit -> cross-device failover",
      }),
    ]);
    const shown = JSON.stringify(entry);
    expect(shown).not.toContain("master-reaper");
    expect(shown).not.toContain("failover");
    expect(entry).not.toHaveProperty("detail");
  });

  // ISS-1228 round 17 (judge-47): a taken job read "no runner has picked it up · unassigned" while the
  // Pipeline page held it on its box, and work not yet started read "Ran".
  it("names the box that took a job it has not started, never unassigned", () => {
    const [entry] = deriveActivityFeed([
      attempt({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        deviceId: null,
        deviceName: null,
        takenBy: { deviceId: "d9", deviceName: "box-taker" },
      }),
    ]);
    expect(entry?.outcome).toBe("Taken by box-taker, not started yet");
    expect(entry?.device).toBe("box-taker");
    // The master's read of the r17 shots: the row said Queued beside the drawer's Starting.
    expect(entry?.verb).toBe("Starting");
  });

  it("never says Ran or Retried of an attempt that has not started", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "failed", failureCause: "agent_killed" }),
      attempt({ status: "queued", startedAt: null, ranAt: null, finishedAt: null }),
      attempt({ jobType: "review", status: "dispatched", ranAt: null, finishedAt: null }),
      attempt({ jobType: "smoke", status: "queued", startedAt: null, ranAt: null, finishedAt: null, takenBy: { deviceId: "d9", deviceName: null } }),
      attempt({ jobType: "drive", status: "running", finishedAt: null }),
      attempt({ jobType: "pm", status: "held", startedAt: null, ranAt: null, finishedAt: null }),
    ]);
    expect(feed.map((e) => e.verb)).toEqual(["Ran", "Queued", "Starting", "Starting", "Running", "Held"]);
  });

  // ISS-1228 round 18 (judge-53): past core's queue timeout a taken job read "Taken by a runner" over
  // the failed session's "No runner picked it up" remedy, and a sent job core timed out before any box
  // claimed it read "Ran · Queue timeout".
  it("shows no cause or remedy on an attempt still open, whatever its session ended of", () => {
    const feed = deriveActivityFeed([
      attempt({
        status: "queued",
        startedAt: null,
        ranAt: null,
        finishedAt: null,
        deviceId: null,
        deviceName: null,
        failureCause: "queue_timeout",
        failureDetail: "no worker claimed the session within the queue timeout",
        takenBy: { deviceId: "d9", deviceName: "box-taker" },
      }),
      attempt({ status: "dispatched", ranAt: null, finishedAt: null, failureCause: "queue_timeout" }),
    ]);
    expect(feed.map((e) => [e.cause, e.action, e.tone])).toEqual([
      [null, null, "open"],
      [null, null, "open"],
    ]);
    expect(feed.map((e) => e.outcome)).toEqual([
      "Taken by box-taker, not started yet",
      "Sent to ubuntu5, not started yet",
    ]);
  });

  it.each([
    ["ran, then never started", ["2026-08-30T10:00:06.000Z", null]],
    ["never started, then ran", [null, "2026-08-30T10:00:06.000Z"]],
  ])("keeps two otherwise identical attempts apart when one %s, each with its own verb", (_n, ranAts) => {
    const feed = deriveActivityFeed(
      ranAts.map((ranAt) =>
        attempt({ status: "cancelled", failureReason: "runner_full", failureCause: null, ranAt }),
      ),
    );
    expect(feed.map((e) => e.verb)).toEqual(
      ranAts.map((r, i) => (r ? (i === 0 ? "Ran" : "Retried") : "Never started")),
    );
  });

  it("reads an attempt that ended before any box started it as Never started, never Ran", () => {
    const feed = deriveActivityFeed([
      attempt({
        status: "failed",
        ranAt: null,
        failureCause: "queue_timeout",
        failureReason: "dispatch never claimed by a runner (no ack / no started event within grace window)",
      }),
      attempt({ jobType: "review", status: "cancelled", ranAt: null, failureCause: "pipeline_cancelled" }),
      attempt({ jobType: "smoke", status: "failed", failureCause: "agent_killed" }),
    ]);
    expect(feed.map((e) => e.verb)).toEqual(["Never started", "Never started", "Retried"]);
  });

  it("says which box never took an attempt that timed out in the queue, and names it in the remedy", () => {
    const sent = { status: "failed", ranAt: null, failureCause: "queue_timeout", deviceName: "box-a" } as const;
    expect(deriveActivityFeed([attempt(sent)])[0]).toMatchObject({
      verb: "Never started",
      outcome: "box-a never took it before the queue timeout",
      action: "Check that box-a is online and its runner is running.",
    });
    const unsent = { ...sent, deviceId: null, deviceName: null };
    expect(deriveActivityFeed([attempt(unsent)])[0]).toMatchObject({
      outcome: "No box took it before the queue timeout",
      action: "Check that a box bound to this project is online.",
    });
  });

  it("says nothing is asked of a person, in place of a remedy, on an attempt core already sent again", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "failed", ranAt: null, failureCause: "queue_timeout", deviceName: "box-a" }),
      attempt({ status: "queued", startedAt: null, ranAt: null, finishedAt: null, deviceId: null, deviceName: null }),
    ]);
    expect(feed.map((e) => [e.verb, e.action, e.note])).toEqual([
      ["Never started", null, "Core already sent it again, so nothing is asked of you."],
      ["Queued", null, null],
    ]);
  });

  it("labels the first attempt Ran and a later one Retried", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "done", failureCause: null }),
      attempt({ jobType: "review", failureCause: "agent_killed" }),
    ]);

    expect(feed.map((e) => e.verb)).toEqual(["Ran", "Retried"]);
  });

  it("returns nothing for a run that has not recorded an attempt", () => {
    expect(deriveActivityFeed([])).toEqual([]);
    expect(deriveActivityFeed(undefined)).toEqual([]);
  });
});

describe("filterActivity", () => {
  it("keeps only real failures, so a cleanup-only run filters to empty", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "done", failureCause: null }),
      attempt({ failureCause: "pipeline_completed" }),
    ]);

    expect(filterActivity(feed, "all")).toHaveLength(2);
    expect(filterActivity(feed, "failures")).toHaveLength(0);
  });
});

/** ISS-1228 round 19 (judge-57): what each attempt says, read against the attempt after it. */
describe("round 19: held, cancelled, question and control-free remedies", () => {
  const never = { status: "failed", ranAt: null, failureCause: "queue_timeout", deviceName: "j57-b" } as const;

  it("reads a held attempt Held, says why and that core sends it again, and asks nothing", () => {
    const feed = deriveActivityFeed([
      attempt(never),
      attempt({
        status: "held",
        ranAt: null,
        finishedAt: null,
        deviceId: null,
        deviceName: null,
        failureCause: null,
        failureReason: "all_devices_exhausted",
        hold: { reason: "all_devices_exhausted", resumesItself: true, recheckAt: null, since: null },
      }),
    ]);
    expect(feed[0]?.note).toBe("Core holds the next try, so nothing is asked of you here.");
    expect([feed[1]?.verb, feed[1]?.outcome, feed[1]?.action]).toEqual([
      "Held",
      "No box could take it. Core sends it again once a box can take it.",
      null,
    ]);
  });

  it("names what to do on a hold that does not clear on its own, with a control the drawer offers", () => {
    const [held] = deriveActivityFeed([
      attempt({
        status: "held",
        ranAt: null,
        finishedAt: null,
        failureCause: null,
        hold: { reason: "retry_rounds_exhausted", resumesItself: false, recheckAt: null, since: null },
      }),
    ]);
    expect(held?.outcome).toBe("It failed on every try core gave it. This hold does not clear on its own.");
    expect(held?.action).toContain("Cancel run");
  });

  it("names the box on the latest never-taken attempt where nothing follows it", () => {
    expect(deriveActivityFeed([attempt(never)])[0]?.action).toBe(
      "Check that j57-b is online and its runner is running.",
    );
  });

  // ISS-1228 round 20 (judge-62): a cancelled retry hid the box's remedy as if core had sent it again.
  it("names the box on a never-taken attempt whose only later attempt a person cancelled", () => {
    const feed = deriveActivityFeed([
      attempt(never),
      attempt({ status: "cancelled", ranAt: null, failureCause: null, cancelledBy: { kind: "person", userId: "u1", name: "Sam" } }),
    ]);
    expect(feed[0]?.action).toBe("Check that j57-b is online and its runner is running.");
  });

  it.each([
    ["open", { status: "queued", ranAt: null, finishedAt: null, failureCause: null }],
    ["failed", { ...never }],
  ] as const)("asks nothing of a never-taken attempt behind a cancel and a later %s attempt", (_name, third) => {
    const feed = deriveActivityFeed([
      attempt(never),
      attempt({ status: "cancelled", ranAt: null, failureCause: null, cancelledBy: { kind: "person", userId: "u1", name: "Sam" } }),
      attempt(third),
    ]);
    expect(feed[0]?.note).toBe("Core already sent it again, so nothing is asked of you.");
  });

  it("says Cancelled by you to the person who cancelled, and their name to anyone else", () => {
    const cancelled = attempt({
      status: "cancelled",
      ranAt: null,
      failureCause: null,
      cancelledBy: { kind: "person", userId: "u1", name: "another member" },
    });
    expect(deriveActivityFeed([cancelled], undefined, "u1")[0]?.outcome).toBe("Cancelled by you");
    expect(deriveActivityFeed([cancelled], undefined, "u2")[0]?.outcome).toBe("Cancelled by another member");
    expect(deriveActivityFeed([cancelled])[0]?.outcome).toBe("Cancelled by another member");
  });

  // r20 review F1: an agent acting on the reader's account cancelled it, not the reader.
  it("never says you for an agent that cancelled on the reader's account", () => {
    const byAgent = attempt({
      status: "cancelled",
      ranAt: null,
      failureCause: null,
      cancelledBy: { kind: "agent", userId: "u1", name: "forge-runner" },
    });
    expect(deriveActivityFeed([byAgent], undefined, "u1")[0]?.outcome).toBe("Cancelled by forge-runner");
  });

  it("reads a person's cancel as theirs, never an earlier take's queue timeout", () => {
    const [line] = deriveActivityFeed([
      attempt({
        status: "cancelled",
        ranAt: null,
        failureCause: null,
        failureReason: "pipeline_cancelled",
        deviceName: null,
        cancelledBy: { kind: "person", name: "Sam" },
      }),
    ]);
    expect([line?.outcome, line?.cause, line?.action, line?.tone]).toEqual(["Cancelled by Sam", null, null, "swept"]);
  });

  it("reads a cancel even where core still answers an old session cause beside it", () => {
    const [line] = deriveActivityFeed([
      attempt({ status: "cancelled", ranAt: null, failureCause: "queue_timeout", cancelledBy: { kind: "person", name: null } }),
    ]);
    expect(line?.outcome).toBe("Cancelled by a person");
    expect(line?.action).toBeNull();
  });

  // ISS-1228 round 20 (judge-62): the r19 case fed a null cause; core answers the session's cause, which
  // it now keeps as the question stop the blocked door recorded.
  it("reads a job that stopped on a question as that, never Unclassified", () => {
    const [line] = deriveActivityFeed([
      attempt({ status: "failed", failureCause: "stopped_on_question", failureReason: "stopped_on_question" }),
    ]);
    expect(line?.outcome).toBe("Stopped to ask a question");
    expect(line?.action).toBe("Answer its question on the Questions tab.");
  });

  // The master's ruling: a job working an issue asks on that issue, which the issue page shows; one
  // asked after its issue closed stands on the project, so the drawer reads where it stands.
  it.each([
    ["issue", "Answer its question on its issue's page."],
    ["project", "Answer its question on the Questions tab."],
  ] as const)("sends a question standing on the %s to where it is answered", (questionOn, action) => {
    const [line] = deriveActivityFeed([
      attempt({ status: "failed", failureCause: "stopped_on_question", failureReason: "stopped_on_question", questionOn }),
    ]);
    expect(line?.action).toBe(action);
  });

  it.each([
    "heartbeat_timeout",
    "agent_exited_without_result",
    "provider_auth_expired",
    "runner_unreachable",
    "session_lost",
    "no_client_ack",
    "turn_never_reported",
    "user_cancelled",
  ])("names no Retry or Rerun in the remedy for %s", (cause) => {
    for (const ranAt of [null, "2026-08-30T10:00:05.000Z"]) {
      const action = deriveActivityFeed([attempt({ status: "failed", failureCause: cause, ranAt })])[0]?.action ?? "";
      expect(action).not.toMatch(/\b(Retry|Rerun)\b/);
    }
  });

  it("reads an open attempt in the run's blocked word where the box reports the run blocked", () => {
    const [line] = deriveActivityFeed(
      [attempt({ status: "running", finishedAt: null, failureCause: null })],
      "Blocked, holding the box",
    );
    expect(line?.verb).toBe("Blocked, holding the box");
  });
});

// ISS-1228 round 21 (judge-67): the drawer of an answered question still said "Answer its question on
// its issue's page." under the header "Answered"; an attempt no box took wore the chip "unassigned";
// a job its issue's drop cut short read "Completed".
describe("what was answered or cut off reads so", () => {
  const asked = (over: Partial<PipelineRunAttempt> = {}) =>
    attempt({
      status: "failed",
      failureReason: "stopped_on_question",
      failureCause: "stopped_on_question",
      questionOn: "issue",
      ...over,
    });

  it("names who answered a question and when, and asks nothing", () => {
    const at = new Date(Date.now() - 4 * 60_000).toISOString();
    const [mine] = deriveActivityFeed([asked({ questionAnswered: { userId: "u-1", name: "Ann Lee", at } })], undefined, "u-1");
    // ISS-1228 round 22 (criterion 229): a settled note, never the amber remedy.
    expect(mine?.note).toBe("Answered by you, 4m ago.");
    expect(mine?.action).toBeNull();
    const [theirs] = deriveActivityFeed([asked({ questionAnswered: { userId: "u-1", name: "Ann Lee", at } })], undefined, "u-2");
    expect(theirs?.note).toBe("Answered by Ann Lee, 4m ago.");
    expect(theirs?.action).toBeNull();
  });

  it("still sends the reader to a question nobody has answered", () => {
    const [entry] = deriveActivityFeed([asked({ questionAnswered: null })]);
    expect(entry?.action).toBe("Answer its question on its issue's page.");
  });

  it("says nothing is asked once core sent an answered attempt again", () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const [first] = deriveActivityFeed([
      asked({ questionAnswered: { userId: "u-1", name: "Ann Lee", at } }),
      attempt({ status: "queued", ranAt: null, finishedAt: null }),
    ]);
    expect(first?.note).toBe("Answered by Ann Lee, 1m ago. Core already sent it again, so nothing is asked of you.");
  });

  it("never folds two questions with different answers into one line", () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now() - 30_000).toISOString();
    const thenAsked = deriveActivityFeed([
      asked({ jobId: "j-1", questionAnswered: { userId: "u-1", name: "Ann Lee", at } }),
      asked({ jobId: "j-2", questionAnswered: null }),
    ]);
    expect(thenAsked).toHaveLength(2);
    expect(thenAsked[0]?.note).toMatch(/^Answered by Ann Lee, 1m ago\./);
    expect(thenAsked[1]?.action).toBe("Answer its question on its issue's page.");
    const twoPeople = deriveActivityFeed([
      asked({ jobId: "j-1", questionAnswered: { userId: "u-1", name: "Ann Lee", at } }),
      asked({ jobId: "j-2", questionAnswered: { userId: "u-2", name: "Bo Tran", at: later } }),
    ]);
    expect(twoPeople.map((e) => e.note?.split(",")[0])).toEqual(["Answered by Ann Lee", "Answered by Bo Tran"]);
  });

  it("shows no box for an attempt no box took, and says so where its outcome does not", () => {
    const [cancelled] = deriveActivityFeed([
      attempt({ status: "cancelled", deviceId: null, deviceName: null, ranAt: null, cancelledBy: { kind: "person", userId: "u-1", name: "Ann Lee" } }),
    ]);
    expect(cancelled?.device).toBeNull();
    expect(cancelled?.noBox).toBe("No box took it");
    const [timedOut] = deriveActivityFeed([
      attempt({ status: "failed", deviceId: null, deviceName: null, ranAt: null, failureCause: "queue_timeout" }),
    ]);
    expect(timedOut?.outcome).toBe("No box took it before the queue timeout");
    expect(timedOut?.noBox).toBeNull();
    const [queued] = deriveActivityFeed([attempt({ status: "queued", deviceId: null, deviceName: null, ranAt: null, finishedAt: null })]);
    expect(queued?.device).toBeNull();
    expect(queued?.noBox).toBeNull();
  });

  it("reads a job its issue's drop or close cut short as cancelled for that, never Completed", () => {
    const [dropped] = deriveActivityFeed([attempt({ status: "cancelled", failureReason: "issue_dropped" })]);
    expect(dropped?.outcome).toBe("Cancelled because the issue was dropped");
    const [closed] = deriveActivityFeed([attempt({ status: "cancelled", failureReason: "issue_closed" })]);
    expect(closed?.outcome).toBe("Cancelled because the issue was closed");
  });
});
