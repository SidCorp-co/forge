import { describe, expect, it } from "vitest";
import {
  SILENCE_REASON,
  type ConversationMessage,
  type ConversationProgressEntry,
  type ConversationWindow,
  type OutboxMessage,
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

// ISS-1236 r7, judge-144 at ae528e1: with the accepted frame lost, a message still sending was drawn
// below the reply it had started, and moved above it only once the room was read again.
describe("a message still sending beside the reply in progress", () => {
  const progress = {
    conversationId: "c1",
    rev: 3,
    entry: { id: "reply-1", role: "assistant", blocks: [] },
  } as unknown as ConversationProgressEntry;
  const item = (id: string, state: OutboxMessage["state"]): OutboxMessage => ({ id, content: id, state });
  const order = (outbox: OutboxMessage[]) =>
    threadEntries([said], [closed("answered")], outbox, [], progress).map((e) =>
      e.kind === "outbox" ? `${e.item.state}:${e.item.id}` : e.kind,
    );

  it("is drawn above that reply, in send order", () => {
    expect(order([item("o1", "sending")])).toEqual(["said", "sending:o1", "progress"]);
  });

  it("follows the messages already confirmed, and a message queued behind it stays below the reply", () => {
    expect(order([item("o0", "sent"), item("o1", "sending"), item("o2", "queued")])).toEqual([
      "said",
      "sent:o0",
      "sending:o1",
      "progress",
      "queued:o2",
    ]);
  });

  it("leaves a failed message below the reply, beside its Try again", () => {
    expect(order([item("o1", "failed")])).toEqual(["said", "progress", "failed:o1"]);
  });

  it("is drawn last when no reply is in progress", () => {
    const entries = threadEntries([said], [closed("answered")], [item("o1", "sending")]);
    expect(entries.map((e) => e.kind)).toEqual(["said", "outbox"]);
  });
});
