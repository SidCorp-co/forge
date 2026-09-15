// ISS-1004 criterion 28 — a person can tell a turn that said nothing from a turn
// that was never taken.
//
// Both are "no answer appeared" on screen, and the difference is not in any
// message: it is whether the window over that message CLOSED. So these cases are
// about shape — a `silence` entry or a `pending` one — rather than about wording,
// because wording is the thing a later edit changes without meaning to.

import { describe, expect, it } from "vitest";
import {
  SILENCE_REASON,
  conversationTitle,
  threadEntries,
  type ConversationMessage,
  type ConversationWindow,
} from "./types";

const said = (seq: number, over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: `m${seq}`,
  seq,
  role: "user",
  authorUserId: "alice",
  authorLabel: "Alice",
  content: `message ${seq}`,
  silenceReason: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

const window = (over: Partial<ConversationWindow> = {}): ConversationWindow => ({
  id: "w1",
  firstSeq: 0,
  lastSeq: 0,
  closedAt: "2026-09-14T00:00:01.000Z",
  decision: "nothing-to-say",
  decisionDetail: null,
  ...over,
});

describe("threadEntries", () => {
  it("renders a closed window that said nothing as a silence, in the place it happened", () => {
    const entries = threadEntries([said(0), said(1)], [window({ lastSeq: 0 })]);
    expect(entries.map((e) => e.kind)).toEqual(["said", "silence", "said"]);
  });

  // cm:guard the whole criterion in one case: the SAME messages and a window that has not closed must not render as a silence, because "it read this and had nothing to add" and "nobody has got to this yet" are different facts and a person acts differently on each.
  it("renders an open window as pending rather than as a silence", () => {
    const entries = threadEntries([said(0)], [window({ closedAt: null, decision: null })]);
    expect(entries.map((e) => e.kind)).toEqual(["said", "pending"]);
  });

  it("renders an answered window as nothing, because its answer is already a message", () => {
    const entries = threadEntries(
      [said(0), said(1, { role: "assistant", content: "here you are", authorLabel: null })],
      [window({ decision: "answered" })],
    );
    expect(entries.map((e) => e.kind)).toEqual(["said", "said"]);
  });

  it("orders by seq whatever order the rows arrived in", () => {
    const entries = threadEntries([said(2), said(0), said(1)], []);
    expect(entries.map((e) => (e.kind === "said" ? e.message.seq : -1))).toEqual([0, 1, 2]);
  });

  it("names a reason for every decision that is not an answer", () => {
    for (const decision of [
      "nothing-to-say",
      "guard-backoff",
      "guard-agent-loop",
      "guard-dormant",
      "authority-refused",
      "unreachable",
      "undetermined",
    ] as const) {
      const entries = threadEntries([said(0)], [window({ decision })]);
      const silence = entries.find((e) => e.kind === "silence");
      expect(silence, decision).toBeDefined();
      expect(SILENCE_REASON[decision].length).toBeGreaterThan(0);
    }
  });

  it("carries a window's own detail, so a reason can be shown with its evidence", () => {
    const entries = threadEntries([said(0)], [window({ decisionDetail: { consecutiveQuietWindows: 3 } })]);
    const silence = entries.find((e) => e.kind === "silence");
    expect(silence?.kind === "silence" && silence.detail).toEqual({ consecutiveQuietWindows: 3 });
  });
});

describe("conversationTitle", () => {
  const row = {
    id: "c1",
    adapter: "web" as const,
    externalId: "v1",
    shape: "direct" as const,
    title: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    archivedAt: null,
  };

  it("prefers the room's own name", () => {
    expect(conversationTitle({ ...row, title: "Release plan" }, "anything")).toBe("Release plan");
  });

  it("falls back to the first thing said, cut at a length a list column holds", () => {
    expect(conversationTitle(row, `${"x".repeat(80)}`)).toHaveLength(61);
  });

  it("names an empty room rather than rendering a blank", () => {
    expect(conversationTitle(row)).toBe("New conversation");
    expect(conversationTitle({ ...row, title: "   " }, "   ")).toBe("New conversation");
  });
});
