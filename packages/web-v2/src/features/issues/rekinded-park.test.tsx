// A park re-kinded to wait on a resource (ISS-631) reads as state on the issue page (ISS-680,
// FB-281): its question is headed by what it waits on, never "Decision waiting"; the issue page asks
// its reader nothing (ISS-687), the question naming the resource; and the re-point notice in
// the thread says what the park waits on now as a label, the waiting-kind codes in the Developer
// view alone.
//
// @direct-test-of packages/web-v2/src/features/questions/components/issue-questions.tsx
// @direct-test-of packages/web-v2/src/features/questions/components/question-view.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/detail/issue-state-head.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/comment-thread.tsx
// @direct-test-of packages/web-v2/src/features/issues/notice-words.ts

import type { IssueStanding } from "@forge/contracts/issue-standing";
import { NEEDS_INFO_KINDS } from "@forge/contracts/issue-vocabulary";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueQuestions, type AgentQuestion } from "@/features/questions";
import { productCopy } from "@/lib/i18n/product-copy";
import { fakeCore, renderWithQuery } from "@/test/render";
import { CommentThread } from "./components/comment-thread";
import { IssueStateHead } from "./components/detail/issue-state-head";
import type { CommentNode } from "./types";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NEEDED = "a staging database URL";

const parkQuestion = {
  id: "q1",
  projectId: "p1",
  issueId: "i1",
  status: "open",
  blockerKind: "human",
  steps: [{ round: 1, prompt: "The run needs a database to test against.", askedAt: "2026-10-24T00:00:00Z", answerShape: "free_text", needed: NEEDED }],
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
  options: [],
} as unknown as AgentQuestion;

describe("a re-kinded resource question's heading", () => {
  it(`is headed by the resource it waits on, not a decision`, async () => {
    fakeCore(() => ({ body: { questions: [parkQuestion] } }));
    renderWithQuery(<IssueQuestions issueId="i1" parkedForInfo waitingKind="needs_resource" show="now" />);
    const t = productCopy("en");
    const heading = await screen.findByText(t("agents.question.resource"));
    expect(heading).toHaveAttribute("data-question-title", "true");
    expect(screen.queryByText(t("agents.question.waiting"))).toBeNull();
  });
});

// ISS-687 (REQ-68 BC-4, BC-6): the issue page names who the park waits on and asks its reader
// nothing; the resource is asked by its question, in Needs you, on the item the issue serves.
const standing = {
  attentionGroup: "queued",
  state: "needs_info",
  step: null,
  stepStartedAt: null,
  tone: "ready",
  waitingOn: {
    kind: "person",
    who: "Ana",
    act: "supply what it asks for",
    rule: null,
    ref: null,
    dueAt: null,
    says: { who: { key: "standing.who.named", vars: { name: "Ana" } }, act: { key: "issues.standing.act.supply" }, rule: null },
  },
} as unknown as IssueStanding;

describe("the state head of a resource park", () => {
  it(`names who supplies it and asks the reader nothing`, () => {
    renderWithQuery(<IssueStateHead standing={standing} forecast={undefined} />);
    expect(screen.getByTestId("issue-now").textContent).toContain("Ana");
    expect(screen.queryByTestId("issue-needs-you")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// the notice as core's `park-repoint.ts` posts it on a re-kind
const notice = (to: string, from: string): CommentNode =>
  ({
    id: `c-${to}`,
    issueId: "i1",
    authorId: "u1",
    author: { displayName: "forge", isAgent: true },
    body: [
      "↪ **Re-pointed `needs_info`**",
      "",
      `This park is now a \`${to}\` park, waiting on something a person supplies, in place of \`${from}\`. It still returns to the status it left once every one is settled.`,
      "",
      "The run needs a database to test against.",
    ].join("\n"),
    format: "markdown",
    createdAt: "2026-10-24T00:00:00Z",
    replies: [],
    attachments: [],
  }) as unknown as CommentNode;

function thread(node: CommentNode, developer = false) {
  const { container } = renderWithQuery(<CommentThread issueId="i1" comments={[node]} members={undefined} readOnly developer={developer} />);
  return container.textContent ?? "";
}

describe("a re-point notice in the thread", () => {
  for (const kind of [...NEEDS_INFO_KINDS, "needs_something_new"]) {
    it(`reads the ${kind} wait as a label, never a code`, () => {
      const t = productCopy("en");
      const text = thread(notice(kind, "needs_decision"));
      expect(text).not.toMatch(/needs_[a-z_]+/);
      expect(text).not.toContain("Re-pointed");
      const label = kind === "needs_something_new" ? t("issues.waitingKind.unknown") : t(`issues.waitingKind.${kind as (typeof NEEDS_INFO_KINDS)[number]}`);
      expect(text).toContain(t("issues.thread.nowWaitsOn", { what: label }));
      expect(text).toContain("The run needs a database to test against.");
    });
  }

  it("reads as core wrote it, codes and all, in the Developer view", () => {
    const text = thread(notice("needs_resource", "needs_decision"), true);
    expect(text).toContain("needs_resource");
    expect(text).toContain("needs_decision");
  });
});
