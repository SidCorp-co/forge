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

  it("links the release to approve by its version, and names no issue", () => {
    render(
      <FeedbackBanner
        slug="forge-dev"
        f={view({
          phase: "planned",
          attentionGroup: "waiting",
          waitingOn: { kind: "person", who: "A release approver", act: "Approve release 0.4.0-dev.97", rule: "", ref: "0.4.0-dev.97", dueAt: null },
          route: { route: "issue", carriers: [{ key: "ISS-9", status: "awaiting_release", release: "0.4.0-dev.97" }], answer: null },
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "0.4.0-dev.97" });
    expect(link).toHaveAttribute("href", "/projects/forge-dev/releases/0.4.0-dev.97");
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Approve release 0.4.0-dev.97");
    expect(screen.getByTestId("wait-banner")).not.toHaveTextContent("ISS-9");
  });

  it("shows the answer and who gave it where the reporter is asked to confirm it", () => {
    render(
      <FeedbackBanner
        f={view({
          phase: "resolved",
          waitingOn: { kind: "you", who: "You", act: "Confirm the answer", rule: "", ref: null, dueAt: null },
          route: { route: "answer", carriers: [], answer: "Exports run nightly at 02:00." },
          decisions: [{ decision: "triage", route: "answer", decidedByName: "Minh" }] as unknown as FeedbackView["decisions"],
        })}
      />,
    );
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Confirm the answer");
    expect(screen.getByTestId("feedback-answer")).toHaveTextContent("Minh answered: “Exports run nightly at 02:00.”");
  });
});
