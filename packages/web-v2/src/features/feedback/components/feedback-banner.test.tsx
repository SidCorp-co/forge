// A feedback item's banner says whom it waits on from core's read model (dev.53: the master, a holder
// of feedback.approve, the releaser), never deriving it here.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { FeedbackBanner } from "./feedback-facts";

const view = (over: Partial<FeedbackView>): FeedbackView =>
  ({
    phase: "new",
    attentionGroup: "needs_you",
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: say("feedback.rule.triagerTriages", { phase: "new" }) }),
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
          waitingOn: waitingOn("agent", { who: say("standing.who.master"), act: say("standing.act.triage", { what: "FB-9" }), rule: say("feedback.rule.masterOwes", { phase: "new" }) }),
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
          waitingOn: waitingOn("person", { who: say("standing.who.holderOf", { perm: "releases.approve" }), act: say("standing.act.approveReleaseV", { v: "0.4.0-dev.97" }), rule: RULE }, { ref: "0.4.0-dev.97" }),
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
          waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.confirmAnswer"), rule: RULE }),
          route: { route: "answer", carriers: [], answer: "Exports run nightly at 02:00." },
          decisions: [{ decision: "triage", route: "answer", decidedByName: "Minh" }] as unknown as FeedbackView["decisions"],
        })}
      />,
    );
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Confirm the answer");
    expect(screen.getByTestId("feedback-answer")).toHaveTextContent("Minh answered: “Exports run nightly at 02:00.”");
  });
});
