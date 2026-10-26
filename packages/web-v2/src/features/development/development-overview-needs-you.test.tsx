// REQ-68 BC-3, judged red on 0.4.0-dev.325 (K98): Development's Needs you drew every `/needs-you` row,
// the master's own decisions among them and more than three for one person. It draws the one
// decisions read, three at a time with the rest counted and linked to Approvals, as the Dashboard does.

import { type NeedsYouDecision, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEV } from "@/test/vi-chrome-overview";
import { Seeded } from "@/test/vi-chrome-requirements";
import { DevelopmentOverviewScreen } from "./components/development-overview-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

const P = "p1";

const decision = (n: number): NeedsYouDecision => ({
  id: `question:${n}`,
  group: "answer",
  area: "issues",
  entity: "issue",
  key: `ISS-${n}`,
  title: `Question ${n}`,
  opens: { kind: "issue", key: `ISS-${n}` },
  question: `Which way on ISS-${n}?`,
  changes: `What the run on ISS-${n} goes on with`,
  impact: `ISS-${n} waits on this.`,
  recommended: { answerId: "a", why: `Whoever asked recommends a for ISS-${n}.`, by: "asker" },
  noRecommendation: null,
  answers: [{ id: "a", label: "A", act: "question.answer", path: `/api/questions/0000000${n}-0000-4000-8000-000000000000/answer`, body: { round: 1, optionId: "a" }, needsReason: false, declines: false, effect: null, recommended: true }],
  touchedAt: null,
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
});

const READ = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-26T06:00:00.000Z",
  decisions: [1, 2, 3, 4, 5].map(decision),
  total: 5,
  notDecisions: [{ reason: "agent_takes", count: 7, items: [{ key: "FB-277", title: "FB-277", next: "the master takes it", opens: { kind: "feedback", key: "FB-277" } }] }],
});

describe("Development's Needs you (REQ-68 BC-3)", () => {
  it("draws at most three decisions, counts the rest toward Approvals, and lists none the master takes", () => {
    render(
      <Seeded data={[[["issues", "standing", "development-overview", P], DEV], [["needs-you", P], { items: [] }], [["needs-you", P, "decisions"], READ]]}>
        <DevelopmentOverviewScreen scope={{ projectId: P, slug: "hop" }} />
      </Seeded>,
    );
    const section = screen.getByTestId("needs-you");
    expect(within(section).getAllByTestId("needs-you-decision")).toHaveLength(3);
    const more = within(section).getByTestId("needs-you-more");
    expect(more).toHaveTextContent("2");
    expect(more.getAttribute("href")).toBe("/projects/hop/approvals");
    expect(within(section).queryByText("FB-277")).toBeNull();
  });
});
