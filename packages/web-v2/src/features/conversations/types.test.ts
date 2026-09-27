import { describe, expect, it } from "vitest";
import {
  SILENCE_REASON,
  type ConversationMessage,
  type ConversationWindow,
  type SilenceDecision,
  threadEntries,
} from "./types";

const AT = "2026-09-21T10:14:38.790Z";

const said: ConversationMessage = {
  id: "m1",
  seq: 0,
  role: "user",
  authorUserId: "u1",
  authorLabel: "Colin",
  content: "go on then",
  silenceReason: null,
  createdAt: AT,
};

function closed(decision: ConversationWindow["decision"]): ConversationWindow {
  return { id: "w1", firstSeq: 0, lastSeq: 0, closedAt: AT, decision, decisionDetail: null };
}

describe("the decision a stopped turn closes under", () => {
  it("reaches the thread as a silence a reader is given a sentence for", () => {
    const entries = threadEntries([said], [closed("stopped")]);
    expect(entries.map((e) => e.kind)).toEqual(["said", "silence"]);
  });

  it("says a person stopped it, not that the agent had nothing to add", () => {
    expect(SILENCE_REASON.stopped).toContain("You stopped");
    expect(SILENCE_REASON.stopped).not.toContain("nothing to add");
  });

  it("is not the decision an answered window closes under", () => {
    const entries = threadEntries([said], [closed("answered")]);
    expect(entries.map((e) => e.kind)).toEqual(["said"]);
  });
});

describe("every silence has a sentence", () => {
  it("leaves no decision a reader would meet as an empty line", () => {
    const decisions: SilenceDecision[] = [
      "nothing-to-say",
      "guard-backoff",
      "guard-agent-loop",
      "guard-dormant",
      "authority-refused",
      "unreachable",
      "undetermined",
      "stopped",
    ];
    for (const decision of decisions) {
      expect(SILENCE_REASON[decision]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(Object.keys(SILENCE_REASON).sort()).toEqual([...decisions].sort());
  });
});
