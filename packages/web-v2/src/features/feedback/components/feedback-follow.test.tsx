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
    duplicates: [],
    source: null,
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
        reason: sentence(say("feedback.notice.agent")),
        says: { reason: say("feedback.notice.agent") },
        shipped: { at: null, release: null },
        beforeNotices: false,
        noticesBegan: null,
      },
    });
    renderWithQuery(<LinkedFeedback f={f} slug="hop" />);
    expect(screen.getByTestId("ship-notice-not-told").textContent).toContain("The reporter is an agent");
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

