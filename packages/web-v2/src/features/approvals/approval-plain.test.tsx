// ISS-1006, owner 2026-11-05: a question an agent asked is decided from the asker's own plain text in
// one click. The owner's own case: the steward's question on a draft of AdminHub API, whose peek read
// "Open it, merge it into ISS-98, keep it as a draft, or drop it?" with its Why and Rests on in keys.
// With plain text, the peek shows only that text and the answers as buttons naming their outcome
// (Recommended on one); the question, the why, what it rests on and each answer's effect sit behind
// one closed "Technical" fold. Without it, the peek and the row say the agent wrote no summary, and
// the buttons still decide it. A decision no agent writes for (no `plain` field) reads as before.
// Planted red by drawing the old body beside the plain text, and by drawing nothing for `plain: null`.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-row.tsx
// @direct-test-of packages/web-v2/src/features/approvals/components/decision-answers.tsx

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { needsYouDecisionSchema } from "@forge/contracts/needs-you-decisions";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DecisionPeek } from "./components/approval-peek";
import { PendingDecision } from "./components/approval-row";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const PATH = "/api/questions/q89/answer";
const PLAIN =
  "Việc khai báo kiểu dữ liệu cho đơn hàng sẽ được làm ngay.\nYêu cầu của Orbit đang chờ việc này.\nTôi khuyên mở việc này."; // i18n-allow: the plain text is written in the reader's language, the owner's Vietnamese

const answer = (id: string, label: string, effect: string, recommended = false) => ({
  id,
  label,
  act: "question.answer" as const,
  path: PATH,
  body: { round: 1, optionId: id },
  needsReason: !recommended,
  declines: false,
  effect,
  recommended,
});

/** The owner's case 1 as core built it on forge-dev, with the plain text the steward is now taught to write. */
const owners = (plain: string | null | undefined): NeedsYouDecision =>
  needsYouDecisionSchema.parse({
    id: "question:q89",
    group: "answer",
    area: "questions",
    entity: "question",
    key: "1152a5c3-0abf-4685-854f-d0cee04f7447",
    title: "A question a run asked",
    opens: { kind: "requirement", key: "REQ-9" },
    question: "Open it, merge it into ISS-98, keep it as a draft, or drop it?",
    changes: "Whether draft ISS-89 becomes open work",
    impact: "REQ-9 waits on this; only open work is planned and built.",
    recommended: {
      answerId: "steward.open",
      why: "ISS-89 now links agreed REQ-9 and has checkable criteria traced to BC-2 and BC-5; opening it lets its dependent work proceed when its blockers settle.",
      by: "steward",
    },
    noRecommendation: null,
    answers: [
      answer("steward.open", "Open it: admit it for work", "Opens ISS-89 as you; its driver plans it from the requirement and criteria the steward prepared.", true),
      answer("steward.merge:ISS-98", "Merge it into ISS-98", "Copies ISS-89's text to ISS-98 as a comment, then drops ISS-89, as you."),
      answer("steward.keep", "Keep it as a draft", "Keeps ISS-89 as a draft until its standing moves, with your reason."),
      answer("steward.drop", "Drop it: it is not work", "Drops ISS-89 as you, with your reason."),
    ],
    touchedAt: "2026-10-31T09:00:00.000Z",
    stuck: false,
    dueAt: null,
    topic: "question",
    proposal: null,
    evidence: { requirement: { key: "REQ-9", title: "Orbit publishes the admin API contract", revision: 3 }, criteria: { count: 2, codes: ["BC-2", "BC-5"] } },
    ...(plain === undefined ? {} : { plain }),
  });

const peek = { open: "question:q89", position: { at: 1, of: 1 }, set: () => {}, move: () => {} };
const KEY = /\b(?:ISS|REQ|BC)-\d+/;

function drawPeek(d: NeedsYouDecision, onPress = vi.fn()) {
  renderWithQuery(<DecisionPeek d={d} peek={peek} full={{ href: "/x", origin: null }} slug="adminhub-api" noun="Question" typing={null} onType={() => {}} onPress={onPress} />);
  return screen.getByTestId("approval-peek");
}

describe("the owner's question is decided from the plain text alone", () => {
  it("shows the plain text and the outcome buttons, Recommended on one, and no key", () => {
    const panel = drawPeek(owners(PLAIN));
    expect(within(panel).getByTestId("approval-peek-plain").textContent).toBe(PLAIN);
    const labels = within(panel).getAllByTestId("approval-peek-answer-label").map((l) => l.textContent);
    expect(labels).toEqual(["Open it: admit it for work", "Merge it into ISS-98", "Keep it as a draft", "Drop it: it is not work"]);
    const recommended = within(panel).getAllByTestId("approval-peek-answer").filter((b) => b.textContent?.includes("Recommended"));
    expect(recommended.map((b) => b.getAttribute("data-answer"))).toEqual(["steward.open"]);
    // what is asked, why, what it rests on and each answer's effect are behind the closed fold
    for (const gone of ["approval-peek-proposal", "approval-peek-stakes", "approval-peek-why", "approval-peek-evidence", "approval-peek-effects"]) {
      expect(within(panel).queryByTestId(gone)).toBeNull();
    }
    const body = within(panel).getByTestId("approval-peek-decide").textContent ?? "";
    expect(body).not.toMatch(KEY);
    expect(within(panel).getByTestId("approval-peek-foot").textContent).not.toMatch(/Opens ISS-89|Copies|Keeps ISS-89|Drops ISS-89/);
  });

  it("decides in one click on the recommended outcome", () => {
    const onPress = vi.fn();
    const panel = drawPeek(owners(PLAIN), onPress);
    const [first] = within(panel).getAllByTestId("approval-peek-answer");
    if (!first) throw new Error("the peek draws no answer");
    fireEvent.click(first);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0]?.[0]).toMatchObject({ id: "steward.open" });
  });

  it("keeps the technical detail one press away, behind the one fold", () => {
    const panel = drawPeek(owners(PLAIN));
    fireEvent.click(within(within(panel).getByTestId("approval-peek-technical")).getByRole("button", { name: "Technical" }));
    expect(within(panel).getByTestId("approval-peek-proposal").textContent).toContain("Open it, merge it into ISS-98");
    expect(within(panel).getByTestId("approval-peek-why").textContent).toContain("BC-2");
    expect(within(panel).getByTestId("approval-peek-evidence").textContent).toContain("REQ-9");
    expect(within(panel).getByTestId("approval-peek-effects").textContent).toContain("Opens ISS-89 as you");
  });

  it("says the agent wrote no summary where it wrote none, and the buttons still decide it", () => {
    const panel = drawPeek(owners(null));
    expect(within(panel).getByTestId("approval-peek-no-plain").textContent).toBe("No summary");
    expect(within(panel).getAllByTestId("approval-peek-answer")).toHaveLength(4);
  });

  it("draws a decision no agent writes for as before", () => {
    const panel = drawPeek(owners(undefined));
    expect(within(panel).queryByTestId("approval-peek-plain")).toBeNull();
    expect(within(panel).queryByTestId("approval-peek-no-plain")).toBeNull();
    expect(within(panel).getByTestId("approval-peek-proposal").textContent).toContain("Open it, merge it into ISS-98");
  });
});

describe("the Approvals row reads the plain text too", () => {
  const drawRow = (d: NeedsYouDecision) =>
    renderWithQuery(
      <ul>
        <PendingDecision d={d} open={false} selected={false} onOpen={() => {}} onSelect={() => {}} onApprove={() => {}} onDecline={() => {}} />
      </ul>,
    );

  it("shows the plain text's first line in place of the question", () => {
    drawRow(owners(PLAIN));
    expect(screen.getByTestId("approval-row-plain").textContent).toBe("Việc khai báo kiểu dữ liệu cho đơn hàng sẽ được làm ngay."); // i18n-allow: the owner's Vietnamese
    expect(screen.getByTestId("approval-proposal").textContent).not.toMatch(KEY);
  });

  it("says the agent wrote no summary where it wrote none", () => {
    drawRow(owners(null));
    expect(screen.getByTestId("approval-row-no-plain").textContent).toBe("No summary");
  });
});
