// ISS-1006 criterion 7: the Approvals peek shows fewer words than before it read the agent's plain
// text. Measured on the owner's case 1 as drawn here, where a closed fold draws nothing: the peek of
// the steward's question on ISS-89. The count before is what the same render drew at 4caed4b5d (before
// this change), measured by this file run against that tree's peek; a change that adds words back
// goes red here. The card's twin is `conversations/components/proposal-words.test.tsx`.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx

import { needsYouDecisionSchema } from "@forge/contracts/needs-you-decisions";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DecisionPeek } from "./components/approval-peek";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

/** Words as `witness/estimate-words.mjs` counts them. */
const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;
const words = (text: string) => (text.match(WORD) ?? []).length;

/** Measured at 4caed4b5d, the tree before ISS-1006, with this file's own renders. */
const BEFORE_PEEK = 192;

const PATH = "/api/questions/q89/answer";
const answer = (id: string, label: string, effect: string, recommended = false) => ({ id, label, act: "question.answer" as const, path: PATH, body: { round: 1, optionId: id }, needsReason: !recommended, declines: false, effect, recommended });

const PEEK = needsYouDecisionSchema.parse({
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
  recommended: { answerId: "steward.open", why: "ISS-89 now links agreed REQ-9 and has checkable criteria traced to BC-2 and BC-5; opening it lets its dependent work proceed when its blockers settle.", by: "steward" },
  noRecommendation: null,
  answers: [
    answer("steward.open", "Open it: admit it for work", "Opens ISS-89 as you; its driver plans it from the requirement and criteria the steward prepared.", true),
    answer("steward.merge:ISS-98", "Merge it into ISS-98: Khai báo kiểu response cho 24 GET nhóm order và purchase-order (tách từ ISS-89)", "Copies ISS-89's text to ISS-98 as a comment, then drops ISS-89, as you. Both are about GET response schema work under REQ-9."), // i18n-allow: the owner's case as forge-dev drew it
    answer("steward.keep", "Keep it as a draft", "Keeps ISS-89 as a draft until its standing moves, with your reason; the steward does not ask again until then."),
    answer("steward.drop", "Drop it: it is not work", "Drops ISS-89 as you, with your reason."),
  ],
  touchedAt: "2026-10-31T09:00:00.000Z",
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
  evidence: { requirement: { key: "REQ-9", title: "Mọi thao tác đọc của admin-api-v1 khai báo đủ kiểu dữ liệu để Orbit công bố được", revision: 3 }, criteria: { count: 2, codes: ["BC-2", "BC-5"] } }, // i18n-allow: the owner's case as forge-dev drew it
  plain: "Hai mươi bốn màn hình đơn hàng sẽ có kiểu dữ liệu rõ ràng để Orbit công bố.\nViệc của Orbit đang chờ bước này.\nTôi khuyên mở việc này ngay.", // i18n-allow: the plain text in the owner's language
});

const peek = { open: PEEK.id, position: { at: 1, of: 1 }, set: () => {}, move: () => {} };

describe("the peek shows fewer words than before (ISS-1006)", () => {
  it("measures the peek", () => {
    renderWithQuery(<DecisionPeek d={PEEK} peek={peek} full={{ href: "/x", origin: null }} slug="adminhub-api" noun="Question" typing={null} onType={() => {}} onPress={() => {}} />);
    const n = words(screen.getByTestId("approval-peek").textContent ?? "");
    console.info(`WORDS peek=${n}`);
    expect(n).toBeLessThan(BEFORE_PEEK);
  });
});
