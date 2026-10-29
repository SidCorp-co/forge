// REQ-47 BC-13 (ISS-749): an answer to a reopened item names the reopen or reply it answers. The
// triage form sends the one the item stands on, its latest, so a person never types an id.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { say, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { FeedbackActions, standingReplyOf } from "./feedback-actions";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NONE = { triage: false, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: false, message: false, tellShipped: false, note: false, attach: false, clarify: false };

const decision = (id: string, d: string, at: string) => ({
  id,
  decision: d,
  route: d === "triaged" ? "answer" : null,
  carrier: null,
  reason: d === "triaged" ? null : `${d} words`,
  decidedBy: "u1",
  decidedByName: "Ana",
  decidedAgency: "agent",
  decidedAt: at,
  fromSuggestionId: null,
  acceptReason: null,
  inReplyTo: null,
  says: { reason: null },
});

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-1",
    kind: "question",
    severity: "medium",
    phase: "reopened",
    status: "reopened",
    attentionGroup: "needs_you",
    waitingOn: waitingOn("person", { who: say("standing.who.projectMaster"), act: say("standing.act.ship"), rule: say("feedback.rule.issuesCarry") }),
    target: { type: "screen", key: "The board", title: null },
    route: null,
    reporter: { id: "u1", name: "Ana", agency: "agent" },
    whereSeen: null,
    duplicates: [],
    occurrences: [],
    origin: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: { ...NONE, triage: true },
    openSuggestions: 0,
    reporters: [],
    messages: [],
    verified: null,
    recordCheck: null,
    verifyHeld: null,
    snoozed: null,
    decisions: [
      decision("d1", "triaged", "2026-10-01T01:00:00.000Z"),
      decision("d2", "reopened", "2026-10-01T02:00:00.000Z"),
      decision("d3", "triaged", "2026-10-01T03:00:00.000Z"),
      decision("d4", "replied", "2026-10-01T04:00:00.000Z"),
      decision("d5", "snoozed", "2026-10-01T05:00:00.000Z"),
    ],
    ...over,
  }) as FeedbackView;

async function answerSent(f: FeedbackView): Promise<unknown> {
  const calls = fakeCore((c) => (c.method === "POST" ? { body: { feedback: f } } : { body: { suggestions: [], feedback: [], counts: {}, sensitive: false } }));
  renderWithQuery(<FeedbackActions projectId="p1" f={f} />);
  fireEvent.click(screen.getByRole("radio", { name: /Question: answer it/ }));
  fireEvent.change(screen.getByPlaceholderText("The answer the reporter reads"), { target: { value: "Read it at the item." } });
  fireEvent.click(screen.getByRole("button", { name: "Route it" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  return calls.find((c) => c.method === "POST")?.body;
}

describe("an answer to a reopened item", () => {
  it("names the latest reopen or reply, past a later snooze", async () => {
    expect(standingReplyOf(view())).toBe("d4");
    expect(await answerSent(view())).toMatchObject({ route: "answer", answer: "Read it at the item.", inReplyTo: "d4" });
  });

  it("names a reopen where no reply came after it", () => {
    expect(standingReplyOf(view({ decisions: view().decisions.slice(0, 2) }))).toBe("d2");
  });

  it("names nothing on an item that is not reopened", async () => {
    const fresh = view({ status: "new", phase: "new", decisions: [] });
    expect(standingReplyOf(fresh)).toBeUndefined();
    const body = (await answerSent(fresh)) as Record<string, unknown>;
    expect(body).toMatchObject({ route: "answer", answer: "Read it at the item." });
    expect(body).not.toHaveProperty("inReplyTo");
  });
});
