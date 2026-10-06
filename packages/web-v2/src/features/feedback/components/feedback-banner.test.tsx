// A feedback item's banner says whom it waits on from core's read model (dev.53: the master, a holder
// of feedback.approve, the releaser), never deriving it here.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FeedbackView } from "../types";
import { FeedbackBanner } from "./feedback-facts";

const view = (over: Partial<FeedbackView>): FeedbackView =>
  ({
    phase: "new",
    attentionGroup: "needs_you",
    waitingOn: { kind: "you", who: "You", act: "triage it", rule: "new: a holder of feedback.approve triages it", ref: null, dueAt: null },
    ...over,
  }) as FeedbackView;

describe("the feedback banner", () => {
  it("says it waits on you, and what you owe, when core says so", () => {
    render(<FeedbackBanner f={view({})} />);
    const banner = screen.getByTestId("wait-banner");
    expect(banner).toHaveTextContent("Waiting on you:");
    expect(banner).toHaveTextContent("triage it");
    expect(banner).toHaveAttribute("title", "new: a holder of feedback.approve triages it");
  });

  it("names the party core named when it waits on someone else", () => {
    render(
      <FeedbackBanner
        f={view({
          attentionGroup: "waiting",
          waitingOn: { kind: "agent", who: "Master", act: "triage FB-9", rule: "high feedback waits on the master", ref: null, dueAt: null },
        })}
      />,
    );
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Waiting on Master: triage FB-9");
  });

  it("says nothing is owed once it is done", () => {
    render(<FeedbackBanner f={view({ phase: "verified", attentionGroup: "done" })} />);
    const banner = screen.getByTestId("wait-banner");
    expect(banner).toHaveTextContent("Verified.");
    expect(banner).toHaveTextContent("Nothing is owed on it.");
    expect(banner).not.toHaveTextContent("Waiting on");
  });
});
