// ISS-1006 round 2: a pending decision with no plain text reads no less than it did before plain text
// existed. On dev.513, 0 of 32 pending decisions carried plain text, and every Approvals row and peek
// read "No summary" alone, the question line hidden behind Technical. The owner's adminhub-api case
// (the steward's decision on a draft, as core draws it now) and the forge run's question: with no
// plain text, the row, the peek and the dashboard's Needs you list each show the question's own line,
// the row and the peek with the "No summary" marker, the peek with the recommended answer beside it;
// with plain text, each reads its first line. One helper decides it (`decisionLineOf`).
// Planted red by drawing round 1's marker alone where the asker wrote none.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-row.tsx
// @direct-test-of packages/web-v2/src/features/needs-you/components/decision-list.tsx
// @direct-test-of packages/web-v2/src/features/approvals/derive.ts

import { type NeedsYouDecision, needsYouDecisionSchema, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DecisionList } from "@/features/needs-you";
import { DecisionPeek } from "./components/approval-peek";
import { PendingDecision } from "./components/approval-row";
import { narrowed } from "./derive";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

const QUESTION = "Open it, merge it into another issue, keep it as a draft, or drop it?";
const PLAIN = "Orbit can publish the order reads once this is open.\nThe API contract release waits on it.\nI recommend opening it now.";
const PATH = "/api/questions/1cc177cf-760b-4db8-855c-635b80f5f332/answer";

const answer = (id: string, label: string, effect: string, recommended = false, needsReason = !recommended) => ({
  id,
  label,
  act: "question.answer" as const,
  path: PATH,
  body: { round: 1, optionId: id },
  needsReason,
  declines: false,
  effect,
  recommended,
});

/** The owner's adminhub-api decision (dev.513 `needs-you/decisions`), as round 2's core draws it. */
const adminhub = (plain: string | null): NeedsYouDecision =>
  needsYouDecisionSchema.parse({
    id: "question:1cc177cf-760b-4db8-855c-635b80f5f332",
    group: "answer",
    area: "questions",
    entity: "question",
    key: "1cc177cf-760b-4db8-855c-635b80f5f332",
    title: "A question a run asked",
    opens: { kind: "requirement", key: "REQ-9" },
    question: QUESTION,
    changes: "Whether draft ISS-89 becomes open work",
    impact: "REQ-9 waits on this; only open work is planned and built.",
    recommended: { answerId: "steward.open", why: "ISS-89 now links agreed REQ-9 and has checkable criteria traced to BC-2 and BC-5.", by: "steward" },
    noRecommendation: null,
    answers: [
      answer("steward.open", "Open it: admit it for work", "Opens ISS-89 as you; its driver plans it from the requirement and criteria the steward prepared.", true),
      answer("steward.merge:ISS-98", "Merge it into: Declare the response types of 24 order GETs", "Copies ISS-89's text to ISS-98 as a comment, then drops ISS-89, as you."),
      answer("steward.keep", "Keep it as a draft", "Keeps ISS-89 as a draft until its standing moves, with your reason."),
      answer("steward.drop", "Drop it: it is not work", "Drops ISS-89 as you, with your reason."),
    ],
    touchedAt: "2026-10-30T08:53:10.180Z",
    stuck: false,
    dueAt: null,
    topic: "question",
    proposal: null,
    plain,
    evidence: { requirement: { key: "REQ-9", title: "Every admin-api-v1 read declares its types", revision: 3 }, criteria: { count: 7, codes: ["BC-1", "BC-2"] } },
  });

const peek = { open: "question:1cc177cf-760b-4db8-855c-635b80f5f332", position: { at: 1, of: 1 }, set: () => {}, move: () => {} };

function drawPeek(d: NeedsYouDecision) {
  renderWithQuery(<DecisionPeek d={d} peek={peek} full={{ href: "/x", origin: null }} slug="adminhub-api" noun="Question" typing={null} onType={() => {}} onPress={() => {}} />);
  return screen.getByTestId("approval-peek");
}

function drawRow(d: NeedsYouDecision) {
  renderWithQuery(
    <ul>
      <PendingDecision d={d} open={false} selected={false} onOpen={() => {}} onSelect={() => {}} onApprove={() => {}} onDecline={() => {}} />
    </ul>,
  );
  return screen.getByTestId("approval-row");
}

describe("an Approvals row with no plain text reads its question's own line", () => {
  it("shows the question, the No summary marker beside it, and the recommended answer on its ✓", () => {
    const row = drawRow(adminhub(null));
    expect(within(row).getByTestId("approval-row-question").textContent).toBe(QUESTION);
    expect(within(row).getByTestId("approval-row-no-plain").textContent).toContain("No summary");
    expect(within(row).getByTestId("approval-approve").textContent).toBe("Open it: admit it for work");
  });

  it("reads the plain text's first line, and no marker, where the asker wrote one", () => {
    const row = drawRow(adminhub(PLAIN));
    expect(within(row).getByTestId("approval-row-plain").textContent).toBe("Orbit can publish the order reads once this is open.");
    expect(within(row).queryByTestId("approval-row-no-plain")).toBeNull();
    expect(within(row).queryByTestId("approval-row-question")).toBeNull();
  });
});

describe("the peek of a decision with no plain text reads its question's own line", () => {
  it("shows the question, the No summary marker and the recommended answer, the rest behind the closed fold", () => {
    const panel = drawPeek(adminhub(null));
    const face = within(panel).getByTestId("approval-peek-fallback");
    expect(within(face).getByTestId("approval-peek-question").textContent).toBe(QUESTION);
    expect(within(face).getByTestId("approval-peek-no-plain").textContent).toBe("No summary");
    expect(within(face).getByTestId("approval-peek-recommended").textContent).toContain("Recommended: Open it: admit it for work");
    for (const folded of ["approval-peek-stakes", "approval-peek-why", "approval-peek-evidence", "approval-peek-effects"]) {
      expect(within(panel).queryByTestId(folded)).toBeNull();
    }
  });

  it("says the question once: the fold opened keeps the why and the evidence, not the question again", () => {
    const panel = drawPeek(adminhub(null));
    fireEvent.click(within(within(panel).getByTestId("approval-peek-technical")).getByRole("button", { name: "Technical" }));
    expect(within(panel).getByTestId("approval-peek-why").textContent).toContain("BC-2");
    expect(within(panel).getByTestId("approval-peek-evidence").textContent).toContain("REQ-9");
    expect(within(panel).queryByTestId("approval-peek-proposal")).toBeNull();
    expect(panel.textContent?.split(QUESTION)).toHaveLength(2);
  });

  it("reads the plain text alone where the asker wrote one", () => {
    const panel = drawPeek(adminhub(PLAIN));
    expect(within(panel).getByTestId("approval-peek-plain").textContent).toBe(PLAIN);
    expect(within(panel).queryByTestId("approval-peek-fallback")).toBeNull();
  });
});

describe("the dashboard's Needs you list reads the same line", () => {
  const read = (plain: string | null) => needsYouDecisionsSchema.parse({ generatedAt: "2026-11-05T10:00:00.000Z", total: 1, notDecisions: [], decisions: [adminhub(plain)] });

  it("shows the question's own line where the asker wrote none", () => {
    renderWithQuery(<DecisionList read={read(null)} slug="adminhub-api" dense />);
    expect(screen.getByTestId("needs-you-decision-question").textContent).toContain(QUESTION);
  });

  it("shows the plain text's first line where the asker wrote one, and the question no more", () => {
    renderWithQuery(<DecisionList read={read(PLAIN)} slug="adminhub-api" dense />);
    const line = screen.getByTestId("needs-you-decision-question").textContent ?? "";
    expect(line).toContain("Orbit can publish the order reads once this is open.");
    expect(line).not.toContain(QUESTION);
  });

  it("draws the whole plain text in the full list", () => {
    renderWithQuery(<DecisionList read={read(PLAIN)} slug="adminhub-api" />);
    expect(screen.getByTestId("needs-you-decision-question").textContent).toBe(PLAIN);
  });
});

describe("the Approvals search finds a decision by the plain text its row shows", () => {
  it("matches a word only the plain text says", () => {
    const found = narrowed([adminhub(PLAIN), adminhub(null)], { chip: "all", recommends: false, query: "orbit can publish" });
    expect(found.map((d) => d.plain)).toEqual([PLAIN]);
  });
});

describe("the peek with no plain text reads less than before plain text existed, and more than round 1", () => {
  /** Words as `witness/estimate-words.mjs` counts them. */
  const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;
  const words = (text: string) => (text.match(WORD) ?? []).length;
  const ROUND_1 = 46;
  const ofPeek = (d: NeedsYouDecision) => {
    const n = words(drawPeek(d).textContent ?? "");
    document.body.innerHTML = "";
    return n;
  };

  it("measures the owner's adminhub-api peek", () => {
    // `plain` absent draws the peek as it read before ISS-1006: the question, stakes, why and evidence
    const { plain: _, ...unplain } = adminhub(null);
    const before = ofPeek(unplain);
    const fallback = ofPeek(adminhub(null));
    const plain = ofPeek(adminhub(PLAIN));
    process.stdout.write(`WORDS peek before=${before} fallback=${fallback} plain=${plain}\n`);
    expect(fallback).toBeLessThan(before);
    // the question's own line is on the face, beside the marker round 1 drew alone (46 words on this
    // render, measured by planting round 1's marker-only face here)
    expect(fallback).toBeGreaterThanOrEqual(ROUND_1 + words(QUESTION));
  });
});
