import { describe, expect, it } from "vitest";
import {
  blockedText,
  boxOfflineText,
  coreNoteText,
  ENDING_AS_FAILED,
  endsAsFailedInText,
  leaseDisagreementText,
  offlineSessionDisagreementText,
  quietForText,
  quietLastReportedText,
  quietWhyText,
  queuedBehindText,
  sessionDisagreementText,
  sessionEndedText,
  waitingOnText,
} from "./status-sentences";

describe("the lease disagreement, in one sentence (ISS-1228 round 12)", () => {
  it("names the issue, core's hold and what frees it", () => {
    expect(leaseDisagreementText(["ISS-3"])).toBe(
      "The box says it returned ISS-3. Core still holds it. Stop the session to free it.",
    );
  });

  it("names every issue at once, in the plural", () => {
    expect(leaseDisagreementText(["ISS-3", "ISS-4"])).toBe(
      "The box says it returned ISS-3, ISS-4. Core still holds them. Stop the session to free them.",
    );
  });

  it("says nothing where the box and core agree", () => {
    expect(leaseDisagreementText([])).toBeNull();
  });
});

// ISS-1228 round 12 repair 2: the runs tab said "the box is offline · it last reported 3m ago" beside
// the disagreement's sentences. Every status sentence the sessions, runs and pipeline surfaces show
// now comes from here, capitalised and stopped, joined by no middot.
describe("every status sentence, capitalised and stopped", () => {
  const said = [
    leaseDisagreementText(["ISS-3"]) ?? "",
    boxOfflineText("3m ago"),
    sessionDisagreementText("box-live-core-terminal"),
    sessionDisagreementText("box-exited-core-running"),
    offlineSessionDisagreementText("box-live-core-terminal", "52m ago"),
    offlineSessionDisagreementText("box-exited-core-running", "52m ago"),
    ENDING_AS_FAILED,
    endsAsFailedInText("6m 00s"),
    quietForText("5m", false),
    quietForText("11m", true),
    coreNoteText("Its box went offline"),
    quietLastReportedText("Last reported working", "1m ago"),
    quietLastReportedText("Last reported working", null),
    blockedText(waitingOnText("human", "approve the restore")),
    blockedText(null),
    waitingOnText("human", "approve the database restore in Coolify"),
    waitingOnText("machine", null),
    waitingOnText("nobody", null),
    waitingOnText(null, "the deploy window"),
    sessionEndedText("heartbeat_timeout", "No heartbeat"),
    sessionEndedText("user_cancelled", "Stopped"),
    sessionEndedText("session_stopped_checking_in", null),
    quietWhyText("Last reported working", "2m ago"),
  ];

  it("says each as whole sentences: a capital first, a stop last, no middot between", () => {
    for (const text of said) {
      expect(text, text).toMatch(/^[A-Z]/);
      expect(text, text).toMatch(/[.!?]$/);
      expect(text, text).not.toContain("·");
    }
  });

  it("says the offline box, a quiet run, core's note and a bare block as sentences", () => {
    expect(boxOfflineText("3m ago")).toBe("The box is offline. It last reported 3m ago.");
    expect(quietForText("11m", true)).toBe("Quiet. Core is ending it as failed. No check-in for 11m.");
    expect(coreNoteText("Its box went offline.")).toBe("Core's note on this session: Its box went offline.");
    expect(blockedText(null)).toBe("Blocked.");
  });

  // ISS-1228 round 13: the runs tab said "Waiting on a person — approve …" with no stop, while the
  // session page said "Blocked. A person — approve …."; core ending a session printed a bare label.
  it("says a blocked wait in the same sentences wherever it is shown", () => {
    expect(waitingOnText("human", "approve the database restore in Coolify")).toBe(
      "Waiting on a person. Approve the database restore in Coolify.",
    );
    expect(blockedText(waitingOnText("human", "approve the database restore in Coolify"))).toBe(
      "Blocked. Waiting on a person. Approve the database restore in Coolify.",
    );
    expect(waitingOnText("nobody", null)).toBe("Waiting on nobody. This run is a failure with a name.");
  });

  it("says why a session ended as sentences, and a person's stop in one way", () => {
    expect(sessionEndedText("heartbeat_timeout", "No heartbeat")).toBe("The session ended. No heartbeat.");
    expect(sessionEndedText("user_cancelled", "Stopped")).toBe("A person stopped the session.");
  });
});

// ISS-1228 round 15 (judge-39): what the surfaces showed on hover was worded beside them, one line
// with no stop. Every sentence the module holds, and every sentence its functions make, is checked
// here, so a new one that is not a capitalised sentence ending in a stop goes red by name.
describe("every sentence in the one place", () => {
  const SENTENCE = /^[A-Z0-9][\s\S]*[.!?]$/;

  it("is a capitalised sentence ending in a stop, for every string and every map of strings it exports", async () => {
    const all = await import("./status-sentences");
    const seen: string[] = [];
    for (const [name, value] of Object.entries(all)) {
      if (typeof value === "string") seen.push(`${name}: ${value}`);
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) if (typeof v === "string") seen.push(`${name}.${k}: ${v}`);
    }
    expect(seen.length).toBeGreaterThan(20);
    for (const line of seen) expect(line.slice(line.indexOf(": ") + 2), line).toMatch(SENTENCE);
  });

  it("is a capitalised sentence ending in a stop from every function, at one and at many", async () => {
    const s = await import("./status-sentences");
    const made = [
      s.queuedBehindText(0),
      s.queuedBehindText(1),
      s.queuedBehindText(3),
      s.queuedWithNoBoxText(1),
      s.queuedWithNoBoxText(2),
      s.noBoxReportsButWorkedText(1),
      s.noBoxReportsButWorkedText(4),
      s.gateUnreadableDetailText("gate.verdict: bad enum"),
      s.gateAdmittedText(1, "3/day", "5h 00m"),
      s.gateAdmittedText(30, "at an unstated rate", "an unknown span"),
      s.gateReasonText("every one of them: no control capability"),
      s.boxOfflineText("3m ago"),
      s.endsAsFailedInText("8m 30s"),
      s.coreNoteText("Stopped checking in"),
      s.quietForText("1m", true),
      s.sessionEndedText("no_client_ack", "No acknowledgement"),
      s.waitingOnText("human", "approve the restore"),
    ];
    for (const line of made) expect(line, line).toMatch(SENTENCE);
  });

  it("counts a queue in words that agree with it", () => {
    expect([0, 1, 2].map(queuedBehindText)).toEqual([
      "No session is queued behind this box.",
      "1 session is queued behind this box.",
      "2 sessions are queued behind this box.",
    ]);
  });
});
