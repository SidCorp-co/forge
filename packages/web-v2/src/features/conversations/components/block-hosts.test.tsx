// The same block content is drawn the same way on every screen that shows it (REQ-32 BC-4): the chat
// panel and the full-page thread are this conversation thread at two widths, a share page draws its
// frozen document, and each reaches the one block frame, so only the width they are given differs.

import type { ShareSnapshot } from "@forge/contracts/shares";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAnswerView } from "@/features/shares/components/shared-answer";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

afterEach(cleanup);

const frame = {
  fields: [
    { name: "key", type: "ref" as const, label: "Requirement" },
    { name: "title", type: "string" as const, label: "Title" },
    { name: "state", type: "status" as const, label: "State", vocabulary: "requirement" as const },
    { name: "toDo", type: "number" as const, label: "Issues to do" },
  ],
  rows: Array.from({ length: 12 }, (_, i) => ({ key: `REQ-${i + 1}`, title: `Requirement ${i + 1}`, state: "in_delivery", toDo: i })),
};
const block = { v: 1 as const, kind: "table" as const, title: "Progress", columns: ["key", "title", "state", "toDo"], source: { runId: "run-1" }, frame };
const run = { runId: "run-1", queryId: "progress-by-requirement", version: 1, asOf: "2026-10-08T09:30:00.000Z" };

const answer = {
  id: "m2",
  seq: 2,
  role: "assistant",
  authorUserId: null,
  authorLabel: null,
  content: "Here is where it stands.",
  blocks: [{ type: "visual", visual: block, run }],
  silenceReason: null,
  createdAt: "2026-10-08T09:31:00Z",
} as unknown as ConversationMessage;
const window1: ConversationWindow = { id: "w1", firstSeq: 1, lastSeq: 2, closedAt: "2026-10-08T09:31:10Z", decision: null, decisionDetail: null };

function inThread(): string {
  // a share page has no project to link a key to, so the thread is drawn here without one too
  const { container } = render(<ConversationThread projectSlug={undefined} messages={[answer]} windows={[window1]} />);
  return container.querySelector("[data-testid='visual-block']")?.outerHTML ?? "";
}

function onSharePage(): string {
  const snapshot: ShareSnapshot = {
    audience: "link",
    expiresAt: "2026-10-15T09:00:00.000Z",
    document: {
      templateId: "progress",
      version: 1,
      params: {},
      runs: [{ ...run, params: {}, projectId: "p1", actor: { kind: "human", id: "u1" }, frame }],
      blocks: [block],
      narrative: { summary: "", risks: "", recommendations: "" },
    },
  };
  const { container } = render(<SharedAnswerView snapshot={snapshot} />);
  return container.querySelector("[data-testid='visual-block']")?.outerHTML ?? "";
}

describe("one block, every screen", () => {
  it("draws the same markup in the conversation thread and on a share page", () => {
    const thread = inThread();
    cleanup();
    const share = onSharePage();
    expect(thread).toContain("table-show-all");
    expect(thread).toContain('data-value="in_delivery"');
    expect(share).toBe(thread);
  });
});
