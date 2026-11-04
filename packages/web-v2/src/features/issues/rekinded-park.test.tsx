// A park re-kinded to wait on a resource (ISS-631) reads as state on the issue page (ISS-680,
// FB-281): its question is headed by what it waits on, never "Decision waiting"; Needs you names
// the resource its question asks for, never "supply what it asks for"; and the re-point notice in
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
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
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
  for (const language of ["en", "vi"] as const) {
    it(`is headed by the resource it waits on, not a decision (${language})`, async () => {
      fakeCore(() => ({ body: { questions: [parkQuestion] } }));
      renderWithQuery(
        <InterfaceLanguageScope language={language}>
          <IssueQuestions issueId="i1" parkedForInfo waitingKind="needs_resource" show="now" />
        </InterfaceLanguageScope>,
      );
      const t = productCopy(language);
      const heading = await screen.findByText(t("agents.question.resource"));
      expect(heading).toHaveAttribute("data-question-title", "true");
      expect(screen.queryByText(t("agents.question.waiting"))).toBeNull();
    });
  }
});

const standing = {
  attentionGroup: "needs_you",
  state: "needs_info",
  step: null,
  stepStartedAt: null,
  tone: "you",
  waitingOn: {
    kind: "you",
    who: "You",
    act: "supply what it asks for",
    rule: null,
    ref: null,
    dueAt: null,
    says: { who: { key: "standing.who.you" }, act: { key: "issues.standing.act.supply" }, rule: null },
  },
} as unknown as IssueStanding;

describe("Needs you on a resource park", () => {
  for (const language of ["en", "vi"] as const) {
    it(`names the resource the person must provide (${language})`, () => {
      renderWithQuery(
        <InterfaceLanguageScope language={language}>
          <IssueStateHead standing={standing} forecast={undefined} resource={NEEDED} />
        </InterfaceLanguageScope>,
      );
      const needs = screen.getByTestId("issue-needs-you").textContent ?? "";
      expect(needs).toContain(productCopy(language)("issues.needs.supply", { what: NEEDED }));
      expect(needs).not.toContain("supply what it asks for");
    });
  }
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

function thread(node: CommentNode, language: "en" | "vi", developer = false) {
  const { container } = renderWithQuery(
    <InterfaceLanguageScope language={language}>
      <CommentThread issueId="i1" comments={[node]} members={undefined} readOnly developer={developer} />
    </InterfaceLanguageScope>,
  );
  return container.textContent ?? "";
}

describe("a re-point notice in the thread", () => {
  for (const language of ["en", "vi"] as const) {
    for (const kind of [...NEEDS_INFO_KINDS, "needs_something_new"]) {
      it(`reads the ${kind} wait as a label, never a code (${language})`, () => {
        const t = productCopy(language);
        const text = thread(notice(kind, "needs_decision"), language);
        expect(text).not.toMatch(/needs_[a-z_]+/);
        expect(text).not.toContain("Re-pointed");
        const label = kind === "needs_something_new" ? t("issues.waitingKind.unknown") : t(`issues.waitingKind.${kind as (typeof NEEDS_INFO_KINDS)[number]}`);
        expect(text).toContain(t("issues.thread.nowWaitsOn", { what: label }));
        expect(text).toContain("The run needs a database to test against.");
      });
    }
  }

  it("reads as core wrote it, codes and all, in the Developer view", () => {
    const text = thread(notice("needs_resource", "needs_decision"), "en", true);
    expect(text).toContain("needs_resource");
    expect(text).toContain("needs_decision");
  });
});
