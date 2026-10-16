// The Questions page: the questions waiting on the reader, drawn from the one needs-me read (its
// `answer` group only), then the questions people raised, each owed until somebody other than its
// asker replies, naming who owes it, or closed where its issue ended; each by its short form; and
// the form that raises one where it will be answered.
//
// @direct-test-of packages/web-v2/src/features/question-desk/components/raised-list.tsx

import type { RaisedQuestionsResponse, RaisedQuestionView } from "@forge/contracts/comments";
import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { questionDeskApi } from "./api";
import { QuestionDesk } from "./components/question-desk";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

const P = "p1";
const AT = "2026-10-15T08:00:00.000Z";
const ME = { id: "u1", name: "Ana", agency: "human" as const };

const DECISIONS = needsYouDecisionsSchema.parse({
  generatedAt: AT,
  total: 2,
  decisions: [
    {
      group: "answer",
      area: "issues",
      entity: "issue",
      key: "ISS-1",
      title: "Export",
      opens: { kind: "issue", key: "ISS-1" },
      question: "Keep the old export format?",
      recommended: null,
      noRecommendation: "Nobody recommended an answer.",
      answers: [{ id: "keep", label: "Keep it", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "keep" }, needsReason: false, effect: null, recommended: false }],
      touchedAt: AT,
    },
    {
      group: "approve",
      area: "requirements",
      entity: "requirement",
      key: "REQ-1",
      title: "Checkout",
      opens: { kind: "requirement", key: "REQ-1" },
      question: "Accept revision 2 of REQ-1?",
      recommended: null,
      noRecommendation: "Nobody recommended an answer.",
      answers: [{ id: "accept", label: "Accept revision 2", act: "revision.accept", path: `/api/projects/${P}/requirements/REQ-1/revisions/2/accept`, body: {}, needsReason: false, effect: null, recommended: false }],
      touchedAt: AT,
    },
  ],
  notDecisions: [{ reason: "own_work", count: 2, keys: ["REQ-2", "REQ-3"] }],
});

const raised = (id: string, over: Partial<RaisedQuestionView> = {}): RaisedQuestionView => ({
  id,
  target: { scope: "requirement", id: `t-${id}`, key: "REQ-7", title: "Bulk export" },
  summary: `Question ${id}?`,
  author: ME,
  askedAt: AT,
  state: "owed",
  answer: null,
  owedBy: "members",
  withheld: false,
  ...over,
});

const RAISED: RaisedQuestionsResponse = {
  by: "me",
  owed: 2,
  answered: 1,
  closed: 1,
  questions: [
    raised("q1"),
    raised("q2", { target: { scope: "issue", id: "i2", key: "ISS-9", title: "Sync" }, owedBy: "agent" }),
    raised("q3", { state: "answered", owedBy: null, answer: { id: "a3", summary: "Weekly is enough.", author: { id: "u2", name: "Minh", agency: "human" }, at: AT } }),
    raised("q5", { target: { scope: "issue", id: "i5", key: "ISS-5", title: "Old export" }, state: "closed", owedBy: null }),
  ],
};

function core(over: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((c) => {
    const mine = over(c);
    if (mine) return mine;
    if (c.path === `/projects/${P}/needs-you/decisions`) return { body: DECISIONS };
    if (c.path === `/projects/${P}/raised-questions?by=me`) return { body: RAISED };
    if (c.path === `/projects/${P}/raised-questions?by=people`) return { body: { ...RAISED, by: "people", questions: [raised("q9", { author: { id: "u3", name: "Lan", agency: "human" } })], owed: 1, answered: 0, closed: 0 } };
    if (c.path === `/projects/${P}/requirements`) return { body: { requirements: [{ key: "REQ-7", title: "Bulk export" }] } };
    return undefined;
  });
}

describe("the questions waiting on the reader", () => {
  it("lists only the questions owed to the reader, from the needs-me read, with their count", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    const forYou = await screen.findByTestId("question-desk-for-you");
    await waitFor(() => expect(within(forYou).getAllByTestId("needs-you-decision")).toHaveLength(1));
    expect(within(forYou).getByTestId("needs-you-decision").getAttribute("data-group")).toBe("answer");
    expect(within(forYou).queryByText("Accept revision 2 of REQ-1?")).toBeNull();
    expect(within(forYou).queryByTestId("needs-you-left-out")).toBeNull();
    expect(within(forYou).getByText("1")).toBeInTheDocument();
  });
});

describe("the questions raised", () => {
  it("keeps a question owed until someone answers it, naming who owes each", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    const rows = await screen.findAllByTestId("raised-question");
    expect(rows.map((r) => r.dataset.state)).toEqual(["owed", "owed", "answered", "closed"]);
    expect(screen.getByTestId("question-desk-counts").textContent).toBe("2 owed · 1 answered · 1 closed");
    const owedBy = screen.getAllByTestId("raised-question-owed-by");
    expect(owedBy.map((o) => o.dataset.owedBy)).toEqual(["members", "agent"]);
    expect(owedBy[1]?.textContent).toBe("Owed by the project's agent, on its next pass");
    const answered = rows[2];
    expect(within(answered).queryByTestId("raised-question-owed-by")).toBeNull();
    expect(within(answered).getByTestId("raised-question-answer").textContent).toContain("Weekly is enough.");
    expect(within(rows[1]).getByRole("link", { name: "ISS-9" }).getAttribute("href")).toBe("/projects/hop/issues/ISS-9");
  });

  it("reads a question on an ended issue as closed, never as owed", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    const closed = (await screen.findAllByTestId("raised-question")).find((r) => r.dataset.id === "q5");
    if (!closed) throw new Error("q5 is not listed");
    expect(within(closed).queryByTestId("raised-question-owed-by")).toBeNull();
    expect(within(closed).getByTestId("raised-question-closed").textContent).toBe("Closed unanswered: ISS-5 has ended");
    expect(within(closed).getByText("Closed")).toBeInTheDocument();
  });

  it("shows each question by the short form core sends, on one line", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    const summaries = await screen.findAllByTestId("raised-question-summary");
    expect(summaries.map((s) => s.textContent)).toEqual(["Question q1?", "Question q2?", "Question q3?", "Question q5?"]);
    for (const s of summaries) expect(s.className).not.toContain("whitespace-pre");
  });

  it("reads everyone's questions when asked, naming each asker", async () => {
    const calls = core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    await screen.findAllByTestId("raised-question");
    fireEvent.click(screen.getByRole("button", { name: "Everyone's" }));
    await waitFor(() => expect(screen.getAllByTestId("raised-question").map((r) => r.dataset.id)).toEqual(["q9"]));
    expect(calls.some((c) => c.path === `/projects/${P}/raised-questions?by=people`)).toBe(true);
    expect(screen.getByText("Lan")).toBeInTheDocument();
  });

  it("says none were raised in two words", async () => {
    core((c) => (c.path === `/projects/${P}/raised-questions?by=me` ? { body: { by: "me", owed: 0, answered: 0, closed: 0, questions: [] } } : undefined));
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    expect(await screen.findByText("No questions")).toBeInTheDocument();
  });
});

describe("raising a question", () => {
  it("posts a question comment on the picked record, saying a member answers it", async () => {
    const calls = core((c) => (c.method === "POST" ? { status: 201, body: { comment: { id: "c1" } } } : undefined));
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    fireEvent.click(await screen.findByTestId("question-desk-ask"));
    expect(screen.getByTestId("question-ask-who").textContent).toBe("A project member answers it in the record's thread.");
    const target = screen.getByTestId("question-ask-target");
    await waitFor(() => expect(within(target).getByRole("option", { name: "REQ-7 · Bulk export" })).toBeInTheDocument());
    fireEvent.change(target, { target: { value: "REQ-7" } });
    fireEvent.change(screen.getByTestId("question-ask-body"), { target: { value: "  Which formats?  " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/projects/${P}/requirements/REQ-7/comments`);
    expect(post?.body).toEqual({ intent: "question", body: "Which formats?" });
    await waitFor(() => expect(screen.queryByTestId("question-ask")).toBeNull());
  });

  it("will not send without a record or a question", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    fireEvent.click(await screen.findByTestId("question-desk-ask"));
    const send = screen.getByRole("button", { name: "Ask" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByTestId("question-ask-body"), { target: { value: "   " } });
    expect(send).toBeDisabled();
  });

  it("shows core's refusal by name and keeps the form open", async () => {
    core((c) => (c.method === "POST" ? { status: 400, body: { error: "VALIDATION_FAILED", message: "body: too long" } } : undefined));
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    fireEvent.click(await screen.findByTestId("question-desk-ask"));
    const target = screen.getByTestId("question-ask-target");
    await waitFor(() => expect(within(target).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(target, { target: { value: "REQ-7" } });
    fireEvent.change(screen.getByTestId("question-ask-body"), { target: { value: "Which formats?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect((await screen.findByTestId("question-ask-refusal")).textContent).toContain("too long");
    expect(screen.getByTestId("question-ask")).toBeInTheDocument();
  });

  it("on an issue, says the agent answers it", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    fireEvent.click(await screen.findByTestId("question-desk-ask"));
    fireEvent.click(screen.getByRole("button", { name: "Issue" }));
    expect(screen.getByTestId("question-ask-who").textContent).toBe("The project's agent answers it on its next pass.");
  });

  it("on an issue, reads the issue by key and posts to its thread by id", async () => {
    const calls = fakeCore((c) => {
      if (c.path === `/issues/ISS-9?projectId=${P}`) return { body: { id: "0b6c7d2e-1f3a-4c5b-8d9e-0a1b2c3d4e5f" } };
      if (c.method === "POST" && c.path === "/issues/0b6c7d2e-1f3a-4c5b-8d9e-0a1b2c3d4e5f/comments") return { status: 201, body: {} };
      return undefined;
    });
    await questionDeskApi.ask(P, "issue", "ISS-9", "Is the sync nightly?");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /issues/ISS-9?projectId=${P}`, "POST /issues/0b6c7d2e-1f3a-4c5b-8d9e-0a1b2c3d4e5f/comments"]);
    expect(calls[1]?.body).toEqual({ intent: "question", body: "Is the sync nightly?" });
  });
});
