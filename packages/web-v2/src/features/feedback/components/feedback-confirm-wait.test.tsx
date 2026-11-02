// ISS-902: a shipped item whose confirm waits on a date or a room message says so on its page, in a
// short label, with the reason on hover, never a paragraph.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { LinkedFeedback } from "./feedback-facts";

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-470",
    kind: "bug",
    severity: "medium",
    phase: "resolved",
    status: "triaged",
    attentionGroup: "waiting",
    waitingOn: waitingOn("agent", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: RULE }),
    target: { type: "screen", key: "The room", title: null },
    route: null,
    reporter: { id: "a1", name: "agenfold-chat", agency: "agent" },
    whereSeen: null,
    duplicates: [],
    occurrences: [],
    origin: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: {},
    openSuggestions: 0,
    reporters: [],
    messages: [],
    verified: null,
    recordCheck: null,
    verifyHeld: null,
    snoozed: null,
    confirmWait: null,
    shipNotice: null,
    attachments: [],
    decisions: [],
    ...over,
  }) as unknown as FeedbackView;

const wait = { until: "2099-01-05T02:00:00.000Z", on: null, reason: "needs the owner’s next message", setAt: "2026-11-02T00:00:00.000Z", setBy: "m1" };

describe("a waiting confirm on the item's page", () => {
  it("shows the date in a short label, the reason on hover only", () => {
    renderWithQuery(<LinkedFeedback f={view({ confirmWait: wait })} slug="hop" />);
    const fact = screen.getByTestId("confirm-wait-until");
    expect(fact).toHaveTextContent(/^Until /);
    expect(fact).not.toHaveTextContent("needs the owner");
    expect(fact).toHaveAttribute("title", "needs the owner’s next message");
    expect(screen.getByTestId("facts-confirm-wait")).toHaveTextContent("Confirm waits");
  });

  it("names the room message a wait on it also ends on", () => {
    renderWithQuery(<LinkedFeedback f={view({ confirmWait: { ...wait, on: "room_message" } })} slug="hop" />);
    expect(screen.getByTestId("confirm-wait-until")).toHaveTextContent("or a room message");
  });

  it("shows nothing where no wait holds", () => {
    renderWithQuery(<LinkedFeedback f={view()} slug="hop" />);
    expect(screen.queryByTestId("facts-confirm-wait")).toBeNull();
  });
});
