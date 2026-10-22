// The Questions page: the questions waiting on the reader, drawn from the one needs-me read (its
// `answer` group only), then the questions people raised, each owed until somebody other than its
// asker replies, naming who owes it, or closed where its issue ended; each by its short form; and
// the form that raises one where it will be answered.
//
// @direct-test-of packages/web-v2/src/features/question-desk/components/raised-list.tsx
// @direct-test-of packages/web-v2/src/features/question-desk/hooks.ts

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
      answers: [{ id: "keep", label: "Keep it", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "keep" }, needsReason: false, declines: false, effect: null, recommended: false }],
      touchedAt: AT,
      stuck: false,
      dueAt: null,
      id: "d1",
      topic: "question",
      proposal: null,
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
      answers: [{ id: "accept", label: "Accept revision 2", act: "revision.accept", path: `/api/projects/${P}/requirements/REQ-1/revisions/2/accept`, body: {}, needsReason: false, declines: false, effect: null, recommended: false }],
      touchedAt: AT,
      stuck: false,
      dueAt: null,
      id: "d2",
      topic: "question",
      proposal: null,
    },
  ],
  notDecisions: [{ reason: "own_work", count: 2, items: [{ key: "REQ-2", title: "REQ-2", next: null, opens: null }, { key: "REQ-3", title: "REQ-3", next: null, opens: null }] }],
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

const MINE: RaisedQuestionView[] = [
  raised("q1"),
  raised("q2", { target: { scope: "issue", id: "i2", key: "ISS-9", title: "Sync" }, owedBy: "agent" }),
  raised("q3", { state: "answered", owedBy: null, answer: { id: "a3", summary: "Weekly is enough.", author: { id: "u2", name: "Minh", agency: "human" }, at: AT } }),
  raised("q5", { target: { scope: "issue", id: "i5", key: "ISS-5", title: "Old export" }, state: "closed", owedBy: null }),
];
const EVERYONES: RaisedQuestionView[] = [raised("q9", { author: { id: "u3", name: "Lan", agency: "human" } })];

/**
 * Core's raised-questions read over `rows` (in core's order: owed oldest first, the others newest
 * first): the state a read names, a page of it by `offset` and `limit`, the counts over all of them.
 */
function raisedRead(by: string, rows: readonly RaisedQuestionView[]) {
  return (c: Call): { body: RaisedQuestionsResponse } | undefined => {
    const url = new URL(c.path, "http://forge.test");
    if (url.pathname !== `/projects/${P}/raised-questions` || url.searchParams.get("by") !== by) return undefined;
    const of = (state: string) => rows.filter((q) => q.state === state);
    const state = url.searchParams.get("state");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const listed = state ? of(state) : [...rows];
    return {
      body: {
        by: by as RaisedQuestionsResponse["by"],
        owed: of("owed").length,
        answered: of("answered").length,
        closed: of("closed").length,
        questions: listed.slice(offset, offset + limit),
      },
    };
  };
}

function core(over: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined, mine: readonly RaisedQuestionView[] = MINE) {
  return fakeCore((c) => {
    const ours = over(c);
    if (ours) return ours;
    if (c.path === `/projects/${P}/needs-you/decisions`) return { body: DECISIONS };
    const read = raisedRead("me", mine)(c) ?? raisedRead("people", EVERYONES)(c);
    if (read) return read;
    if (c.path === `/projects/${P}/requirements`) return { body: { requirements: [{ key: "REQ-7", title: "Bulk export" }] } };
    return undefined;
  });
}

const rowIds = () => screen.queryAllByTestId("raised-question").map((r) => r.dataset.id);
const toggle = (state: "answered" | "closed") => screen.queryByTestId(`raised-group-${state}`);

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
    await screen.findAllByTestId("raised-question");
    fireEvent.click(await screen.findByTestId("raised-group-answered"));
    fireEvent.click(await screen.findByTestId("raised-group-closed"));
    await waitFor(() => expect(rowIds()).toHaveLength(4));
    const rows = screen.getAllByTestId("raised-question");
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
    fireEvent.click(await screen.findByTestId("raised-group-closed"));
    await waitFor(() => expect(rowIds()).toContain("q5"));
    const closed = screen.getAllByTestId("raised-question").find((r) => r.dataset.id === "q5");
    if (!closed) throw new Error("q5 is not listed");
    expect(within(closed).queryByTestId("raised-question-owed-by")).toBeNull();
    expect(within(closed).getByTestId("raised-question-closed").textContent).toBe("Closed unanswered: ISS-5 has ended");
    expect(within(closed).getByText("Closed")).toBeInTheDocument();
  });

  it("shows each question by the short form core sends, on one line", async () => {
    core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    fireEvent.click(await screen.findByTestId("raised-group-answered"));
    fireEvent.click(await screen.findByTestId("raised-group-closed"));
    await waitFor(() => expect(rowIds()).toHaveLength(4));
    const summaries = screen.getAllByTestId("raised-question-summary");
    expect(summaries.map((s) => s.textContent)).toEqual(["Question q1?", "Question q2?", "Question q3?", "Question q5?"]);
    for (const s of summaries) expect(s.className).not.toContain("whitespace-pre");
  });

  it("reads everyone's questions when asked, naming each asker", async () => {
    const calls = core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    await screen.findAllByTestId("raised-question");
    fireEvent.click(screen.getByRole("button", { name: "Everyone's" }));
    await waitFor(() => expect(screen.getAllByTestId("raised-question").map((r) => r.dataset.id)).toEqual(["q9"]));
    expect(calls.some((c) => c.path.startsWith(`/projects/${P}/raised-questions?by=people&state=owed`))).toBe(true);
    expect(screen.getByText("Lan")).toBeInTheDocument();
  });

  it("says none were raised in two words", async () => {
    core(undefined, []);
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    expect(await screen.findByText("No questions")).toBeInTheDocument();
    expect(toggle("answered")).toBeNull();
    expect(toggle("closed")).toBeNull();
  });
});

// Live dev.251's Questions page listed all 566 answered and closed rows, about 9k words, almost all
// release records with a "Thanks." reply. The page leads with what is owed; the rest is a count.
describe("the questions raised, owed first", () => {
  /** `n` closed questions in core's order, newest first: c0 is the newest. */
  const closedRows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      raised(`c${i}`, { target: { scope: "issue", id: `i-c${i}`, key: `ISS-${100 + i}`, title: "Release" }, state: "closed", owedBy: null, askedAt: new Date(Date.parse(AT) - i * 60_000).toISOString() }),
    );

  it("lists only the owed rows, and shows answered and closed as counts, folded", async () => {
    const calls = core();
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    await waitFor(() => expect(rowIds()).toEqual(["q1", "q2"]));
    expect(screen.getByTestId("question-desk-counts").textContent).toBe("2 owed · 1 answered · 1 closed");
    expect(toggle("answered")?.textContent).toBe("1 answered");
    expect(toggle("closed")?.textContent).toBe("1 closed");
    expect(toggle("answered")?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle("closed")?.getAttribute("aria-expanded")).toBe("false");
    // nothing answered or closed crosses the wire until a reader opens it
    expect(calls.some((c) => /state=(answered|closed)/.test(c.path))).toBe(false);
    expect(calls.some((c) => c.path.includes("raised-questions") && !c.path.includes("state=owed"))).toBe(false);
  });

  it("opens a group to its 20 newest, and Show more adds 20 more until none is left", async () => {
    const closed = closedRows(45);
    const calls = core(undefined, [...MINE.filter((q) => q.state !== "closed"), ...closed]);
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    await waitFor(() => expect(rowIds()).toEqual(["q1", "q2"]));
    const group = toggle("closed");
    expect(group?.textContent).toBe("45 closed");
    fireEvent.click(group as HTMLElement);
    expect(toggle("closed")?.getAttribute("aria-expanded")).toBe("true");
    const shown = () => rowIds().filter((id) => id?.startsWith("c"));
    await waitFor(() => expect(shown()).toEqual(closed.slice(0, 20).map((q) => q.id)));
    expect(calls.some((c) => c.path.endsWith("state=closed&offset=0&limit=20"))).toBe(true);
    fireEvent.click(screen.getByTestId("raised-more-closed"));
    await waitFor(() => expect(shown()).toEqual(closed.slice(0, 40).map((q) => q.id)));
    fireEvent.click(screen.getByTestId("raised-more-closed"));
    await waitFor(() => expect(shown()).toEqual(closed.map((q) => q.id)));
    expect(screen.queryByTestId("raised-more-closed")).toBeNull();
  });

  it("folds a group back on a second click, and opens it again at 20", async () => {
    const closed = closedRows(30);
    core(undefined, [...MINE.filter((q) => q.state !== "closed"), ...closed]);
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    fireEvent.click(await screen.findByTestId("raised-group-closed"));
    await waitFor(() => expect(rowIds().filter((id) => id?.startsWith("c"))).toHaveLength(20));
    fireEvent.click(screen.getByTestId("raised-more-closed"));
    await waitFor(() => expect(rowIds().filter((id) => id?.startsWith("c"))).toHaveLength(30));
    fireEvent.click(screen.getByTestId("raised-group-closed"));
    await waitFor(() => expect(rowIds()).toEqual(["q1", "q2"]));
    fireEvent.click(screen.getByTestId("raised-group-closed"));
    await waitFor(() => expect(rowIds().filter((id) => id?.startsWith("c"))).toHaveLength(20));
  });

  it("draws no toggle for an empty group, and says so when nothing is owed", async () => {
    core(undefined, MINE.filter((q) => q.state === "closed"));
    renderWithQuery(<QuestionDesk projectId={P} slug="hop" />);
    expect(await screen.findByTestId("raised-group-closed")).toBeInTheDocument();
    expect(toggle("answered")).toBeNull();
    expect(rowIds()).toEqual([]);
    expect(screen.getByTestId("raised-owed-none").textContent).toBe("Nothing owed");
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
