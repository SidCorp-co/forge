// Feedback follows its work to the release (the ETA, who owes the cut and the release link are the
// progress block's, `feedback-progress.test.tsx`): whether the reporter was told it shipped, or why nobody could be.

import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { RULE, say, sentence, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { LinkedFeedback } from "./feedback-facts";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const NONE = { triage: false, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: false, message: false, note: false };
const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-4",
    kind: "bug",
    severity: "medium",
    phase: "resolved",
    status: "triaged",
    attentionGroup: "moving",
    waitingOn: waitingOn("issue", { who: say("standing.who.named", { name: "ISS-51" }), act: say("standing.act.ship"), rule: RULE }, { ref: "ISS-51" }),
    target: { type: "screen", key: "The board", title: null },
    route: null,
    reporter: { id: "u9", name: "Ana", agency: "human" },
    whereSeen: null,
    duplicates: [],    occurrences: [],
    origin: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: NONE,
    openSuggestions: 0,
    reporters: [],
    messages: [],
    verified: null,
    recordCheck: null,
    verifyHeld: null,
    snoozed: null,
    shipNotice: null,
    ...over,
  }) as FeedbackView;

describe("feedback follows its work to the release", () => {
  it("says when the reporter was told; the release is the answer line's, said once (REQ-43 BC-5)", () => {
    const f = view({ shipNotice: { state: "told", how: "notice", at: at(-5), release: "0.1.0", by: null, shipped: { at: at(-6), release: "0.1.0" }, told: null, says: { told: null } } });
    renderWithQuery(<LinkedFeedback f={f} slug="hop" />);
    const fact = screen.getByTestId("facts-ship-notice");
    expect(fact.textContent).toContain("Reporter told");
    expect(within(fact).queryByRole("link", { name: "0.1.0" })).toBeNull();
    expect(within(fact).getByTestId("ship-notice-told")).not.toBeEmptyDOMElement();
  });

  it("names a reporter nobody could reach instead of leaving the row out", () => {
    const f = view({
      shipNotice: {
        state: "not_told",
        reason: sentence(say("feedback.notice.turnedOff")),
        says: { reason: say("feedback.notice.turnedOff") },
        shipped: { at: null, release: null },
        beforeNotices: false,
        noticesBegan: null,
      },
    });
    renderWithQuery(<LinkedFeedback f={f} slug="hop" />);
    expect(screen.getByTestId("ship-notice-not-told").textContent).toContain("turned this notice off");
  });

  // REQ-66 BC-8: an agent reporter hears through its own read of the item, and the evidence is shown
  it("reads an agent reporter as asked to confirm, with when, and shows the verdict and clip it confirms from", () => {
    const told = say("feedback.told.agentAsked");
    const f = view({
      shipNotice: { state: "told", how: "asked", at: at(-5), release: "0.1.0", by: null, shipped: { at: at(-5), release: "0.1.0" }, told: sentence(told), says: { told } },
      shipEvidence: {
        criterion: "REQ-3 BC-2",
        verdict: "passing",
        why: null,
        clip: { name: "bc2.webm", mime: "video/webm", url: "/api/attachments/a1/download" },
        reads: "REQ-3 BC-2 passes on the running build.",
        says: { reads: say("feedback.evidence.passes", { ref: "REQ-3 BC-2" }) },
      },
    });
    renderWithQuery(<LinkedFeedback f={f} slug="hop" />);
    const row = screen.getByTestId("facts-ship-notice");
    expect(row.textContent).toContain("Asked to confirm");
    expect(row.textContent).toMatch(/Asked to confirm\d+\w+ ago$/);
    expect(row.textContent, "no plumbing on a person's page").not.toMatch(/own read|reporter told/i);
    expect(screen.getByTestId("ship-evidence").textContent).toContain("REQ-3 BC-2 passes on the running build.");
    expect(screen.getByTestId("ship-evidence-clip")).toHaveAttribute("href", "/api/attachments/a1/download");
  });

  it("says shipped work shipped, in which release and when, never that no release has told", () => {
    const f = view({
      shipNotice: {
        state: "not_told",
        reason: sentence(say("feedback.notice.before", { date: "2026-10-07" })),
        says: { reason: say("feedback.notice.before", { date: "2026-10-07" }) },
        shipped: { at: "2026-10-07T04:13:32.795Z", release: "0.4.0-dev.89" },
        beforeNotices: true,
        noticesBegan: "2026-10-07T07:39:54.217Z",
      },
    });
    renderWithQuery(<LinkedFeedback f={f} slug="hop" />);
    const line = screen.getByTestId("ship-notice-not-told");
    expect(line.textContent).toContain("Shipped in 0.4.0-dev.89 on ");
    expect(screen.getByTestId("ship-notice-before").textContent).toBe("Shipped before release notices existed on this project (2026-10-07).");
    expect(line.textContent).not.toContain("No release has told");
    expect(within(line).getByRole("link", { name: "0.4.0-dev.89" }).getAttribute("href")).toBe("/projects/hop/releases/0.4.0-dev.89");
  });

  it("shows no told row before the work has shipped", () => {
    renderWithQuery(<LinkedFeedback f={view({ phase: "planned" })} slug="hop" />);
    expect(screen.queryByTestId("facts-ship-notice")).toBeNull();
  });
});


describe("feedback reported through the Forge door (REQ-47 BC-4)", () => {
  const origin = {
    occurrences: 3,
    project: { id: "p-hop", slug: "hop", name: "HOP" },
    issue: { id: "i-4", key: "ISS-4" },
    run: "r-1",
    clientVersion: "forge-plugin 3.36.542",
    reporter: { id: "a1", name: "hop-runner", agency: "agent" as const },
    at: at(-60),
  };

  it("says where it came from and how many times it was reported, to every reader", () => {
    renderWithQuery(<LinkedFeedback f={view({ origin, reporter: origin.reporter })} slug="forge" />);
    const from = screen.getByTestId("facts-origin");
    expect(within(from).getByRole("link", { name: "HOP" }).getAttribute("href")).toBe("/projects/hop");
    expect(screen.getByRole("link", { name: "ISS-4" }).getAttribute("href")).toBe("/projects/hop/issues/ISS-4");
    expect(screen.getByText("forge-plugin 3.36.542")).toBeTruthy();
    expect(screen.getByTestId("facts-reports").textContent).toContain("3");
  });

  it("draws no origin for an item filed through the project's own door", () => {
    renderWithQuery(<LinkedFeedback f={view()} slug="hop" />);
    expect(screen.queryByTestId("facts-origin")).toBeNull();
  });
});
