// The thread draws one statement per window, in the place it happened (dev.55): a window handed to
// the onboarding job says so, a window whose status already reached the room draws no second
// sentence, and a failed turn reads as its coded reason, never as a declined silence.

import { describe, expect, it } from "vitest";
import {
  type ConversationMessage,
  type ConversationWindow,
  silenceSentence,
  threadEntries,
  turnFailureOf,
} from "./types";

const said = (seq: number): ConversationMessage => ({
  id: `m${seq}`,
  seq,
  role: "user",
  authorUserId: "u1",
  authorLabel: "Owner",
  content: `message ${seq}`,
  silenceReason: null,
  createdAt: "2026-10-06T00:00:00Z",
});

const window = (over: Partial<ConversationWindow>): ConversationWindow => ({
  id: "w1",
  firstSeq: 1,
  lastSeq: 1,
  closedAt: "2026-10-06T00:01:00Z",
  decision: "nothing-to-say",
  decisionDetail: null,
  ...over,
});

const kinds = (windows: ConversationWindow[]) => threadEntries([said(1)], windows).map((e) => e.kind);

describe("a window handed to the onboarding job", () => {
  it("says it went to the job, with the reason core gave", () => {
    const entries = threadEntries(
      [said(1)],
      [window({ decision: "handed-off", decisionDetail: { handedTo: "onboarding-job", reason: "the analysis job reads this room" } })],
    );
    expect(entries[1]).toEqual({ kind: "handed", key: "w1", reason: "the analysis job reads this room" });
  });

  it("is an agent turn still pending when it was handed anywhere else", () => {
    expect(kinds([window({ decision: "handed-off", decisionDetail: { handedTo: "agent" } })])).toEqual(["said", "pending"]);
  });
});

describe("a window that ended without an answer", () => {
  it("draws its silence after the message it closed on", () => {
    expect(kinds([window({})])).toEqual(["said", "silence"]);
  });

  it("draws nothing more when its status already reached the room", () => {
    expect(kinds([window({ decisionDetail: { status: { delivered: true } } })])).toEqual(["said"]);
  });

  it("still draws its silence when its status was not delivered", () => {
    expect(kinds([window({ decisionDetail: { status: { delivered: false } } })])).toEqual(["said", "silence"]);
  });

  it("draws nothing for an answered window, and a pending row for one still open", () => {
    expect(kinds([window({ decision: "answered" })])).toEqual(["said"]);
    expect(kinds([window({ closedAt: null, decision: null })])).toEqual(["said", "pending"]);
  });
});

describe("a failed turn", () => {
  it("reads as its coded reason", () => {
    expect(turnFailureOf({ code: "ASSISTANT_TURN_TIMED_OUT", reason: "the turn ran past 90 seconds" })).toEqual({
      code: "ASSISTANT_TURN_TIMED_OUT",
      reason: "the turn ran past 90 seconds",
    });
  });

  it("is not a failure when the code is not one of the turn-failure codes", () => {
    expect(turnFailureOf({ code: "SOMETHING_ELSE", reason: "x" })).toBeNull();
    expect(turnFailureOf({ code: "ASSISTANT_TURN_FAILED" })).toBeNull();
    expect(turnFailureOf(null)).toBeNull();
  });
});

describe("a silence a turn recorded", () => {
  it("reads as a sentence, never as the provider's raw reason", () => {
    expect(silenceSentence("not-mentioned")).toBe("Nobody asked the agent here, so it stayed quiet.");
    expect(silenceSentence("Error: 529 overloaded_error {\"type\":\"error\"}")).toBe("The agent did not answer here.");
  });
});
