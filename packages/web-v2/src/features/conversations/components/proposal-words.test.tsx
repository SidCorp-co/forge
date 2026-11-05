// ISS-1006 criterion 7: the proposal card shows fewer words than before it read the agent's plain
// line. Measured on the owner's case 2, the card "Revision of REQ-68", as drawn here, where a closed
// fold draws nothing. The count before is what the same render drew at 4caed4b5d (before this change),
// measured by this file run against that tree's card; a change that adds words back goes red here.
//
// @direct-test-of packages/web-v2/src/features/conversations/components/proposal-cards.tsx

import type { ChatProposalView } from "@forge/contracts/chat-proposals";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ProposalCards } from "./proposal-cards";

/** Words as `witness/estimate-words.mjs` counts them. */
const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;
const words = (text: string) => (text.match(WORD) ?? []).length;

/** Measured at 4caed4b5d, the tree before ISS-1006, with this file's own render. */
const BEFORE_CARD = 151;

const CARD: ChatProposalView = {
  id: "33333333-3333-4333-8333-333333333333",
  conversationId: "22222222-2222-4222-8222-222222222222",
  kind: "requirement_revision",
  status: "pending",
  summary: {
    title: "Revision of REQ-68",
    lines: [
      'Picture, a rough sketch (a wireframe): A wireframe "Approvals decision, plain-language layout": Approvals, "One decision needs you", "Decide whether to open this work now.", "Why it matters: the related requirement cannot move forward until you decide.", Your choices list of 4, a Choose recommended action button, a Why and evidence button',
      "baseRevision: 1",
      'spec: {"goal":"Problem: people re-review, wait and repeat decisions, or cannot tell what must be decided because approval screens bury the action in dense, low-value copy.","personas":["Product owner","BA","Steward agent"],"scopeOut":["Developer tools for reading issues"]}',
      "kind: screen",
      "tldr: Approvals must lead with one plain-language decision and its consequence, then offer concise choices; supporting evidence stays available without competing with the action.",
      "changeSummary: Make the Approvals decision surface readable and action-led: remove duplicated or internal wording from the primary view, name the choice and consequence plainly, and put supporting detail behind an optional disclosure.",
      "writtenLang: en",
    ],
    relates: ["REQ-68"],
    plain: "Mỗi quyết định trong Duyệt mở ra bằng một dòng dễ hiểu. Tôi khuyên ghi lại bản sửa này.", // i18n-allow: the plain line in the owner's language
  },
  proposedTo: { userId: "44444444-4444-4444-8444-444444444444", label: "Owner" },
  canDecide: true,
  agreedVia: null,
  agreedWords: null,
  record: null,
  failure: null,
  createdAt: "2026-11-05T03:46:00Z",
  decidedAt: null,
};

describe("the card shows fewer words than before (ISS-1006)", () => {
  it("measures the card", async () => {
    fakeCore((c) => (c.method === "GET" && c.path.endsWith("/proposals") ? { body: { proposals: [CARD] } } : undefined));
    renderWithQuery(<ProposalCards conversationId={CARD.conversationId} threadLength={1} />);
    const n = words((await screen.findByTestId("proposal-cards")).textContent ?? "");
    console.info(`WORDS card=${n}`);
    expect(n).toBeLessThan(BEFORE_CARD);
  });
});
