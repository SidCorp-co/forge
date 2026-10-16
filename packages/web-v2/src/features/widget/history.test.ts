import type { WidgetFeedbackDraft, WidgetHistory } from "@forge/contracts/widget";
import { describe, expect, it } from "vitest";
import { mergeHistory, withDraft, withMessage } from "./history";

// The history read and the live stream fill one cache: a line joins by id, never twice, and a read
// that left before an event arrived does not take that event back.

const m = (id: string, at: string, role: "visitor" | "assistant" = "assistant") => ({ id, role, text: id, at });
const draft = (state: WidgetFeedbackDraft["state"]): WidgetFeedbackDraft => ({
  draftId: "d1",
  title: "t",
  did: null,
  saw: "s",
  expected: null,
  whereSeen: null,
  kind: "bug",
  state,
});

describe("the conversation cache", () => {
  it("joins a message by id, in time order", () => {
    let h: WidgetHistory = { messages: [m("b", "2026-10-16T10:00:02Z")], drafts: [] };
    h = withMessage(h, m("a", "2026-10-16T10:00:01Z"));
    h = withMessage(h, { ...m("b", "2026-10-16T10:00:02Z"), text: "edited" });
    expect(h.messages.map((x) => [x.id, x.text])).toEqual([
      ["a", "a"],
      ["b", "edited"],
    ]);
  });

  it("keeps what the stream added while a history read was out", () => {
    const cached = withDraft({ messages: [m("late", "2026-10-16T10:00:09Z")], drafts: [] }, draft("filed"));
    const read: WidgetHistory = { messages: [m("early", "2026-10-16T10:00:01Z")], drafts: [draft("pending")] };
    const merged = mergeHistory(cached, read);
    expect(merged.messages.map((x) => x.id)).toEqual(["early", "late"]);
    expect(merged.drafts).toEqual([draft("filed")]);
  });

  it("takes the read's state for a draft the cache still has pending", () => {
    const merged = mergeHistory({ messages: [], drafts: [draft("pending")] }, { messages: [], drafts: [draft("discarded")] });
    expect(merged.drafts).toEqual([draft("discarded")]);
  });
});
