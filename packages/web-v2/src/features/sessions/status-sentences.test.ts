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
  sessionDisagreementText,
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
    blockedText("A person — approve the restore"),
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
    expect(quietForText("11m", true)).toBe("Quiet. Core is ending it as failed. No report for 11m.");
    expect(coreNoteText("Its box went offline.")).toBe("Core's note on this session: Its box went offline.");
    expect(blockedText(null)).toBe("Blocked");
  });
});
