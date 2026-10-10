// An owner's ruling is recorded as a decision, apart from the thread's chatter (dev.55): the composer's
// Decision mode asks for what is decided and why, sends them as fields with intent `decision` so core
// writes the body every agent reads, and a decision in the thread wears its own badge.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import type { AgentQuestion } from "@/features/questions/types";
import type { CommentNode } from "../types";
import { CommentThread } from "./comment-thread";

// CodeMirror takes no typing under jsdom; the box a comment is written in stands in as a textarea.
vi.mock("./body-editor", () => ({
  BodyEditor: ({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) => (
    <textarea placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const decided = {
  id: "c1",
  body: "**Decision:** ship behind the flag\n\n**Reason:** the migration is not reversible",
  intent: "decision",
  decision: { decision: "ship behind the flag", reason: "the migration is not reversible" },
  createdAt: "2026-10-06T00:00:00Z",
  authorId: "u1",
  replies: [],
  attachments: [],
} as unknown as CommentNode;

/** The decision box reads the issue's open questions (FB-80): this issue has none to settle. */
const noOpenQuestion = (c: { method: string; path: string }) =>
  c.method === "GET" && c.path.startsWith("/questions?") ? { body: { questions: [] } } : undefined;

async function openDecisionMode() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Decision" }));
  const box = await screen.findByTestId("record-decision");
  return { user, box };
}

describe("recording a decision on an issue", () => {
  it("cannot be sent until both what is decided and why are written", async () => {
    const calls = fakeCore(noOpenQuestion);
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    const send = within(box).getByRole("button", { name: "Record decision" });
    expect(send).toBeDisabled();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship behind the flag");
    expect(send).toBeDisabled();
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "   ");
    expect(send).toBeDisabled();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("sends the fields with intent decision, not a body of its own", async () => {
    const calls = fakeCore((c) => noOpenQuestion(c) ?? { status: 201, body: decided });
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "  ship behind the flag ");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "the migration is not reversible");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/issues/i1/comments",
        body: { intent: "decision", decision: { decision: "ship behind the flag", reason: "the migration is not reversible" } },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("record-decision")).toBeNull());
  });

  it("names a refusal by its detail and keeps what was written", async () => {
    fakeCore((c) => noOpenQuestion(c) ?? {
      status: 403,
      body: { error: { code: "COMMENT_REFUSED", message: "refused", refusals: [{ code: "DECISION_NOT_ALLOWED", path: "", detail: "only a person may record a decision" }] } },
    });
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship it");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "because");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("only a person may record a decision");
    expect(within(box).getByRole("textbox", { name: "Decision" })).toHaveValue("ship it");
  });
});

// FB-80 (live dev.227, hop ISS-185): two open free-text questions on the issue, and the composer
// offered none, because it read `currentStep`, which `GET /questions?issueId=` never carries. The
// question here is that read's own shape: every round as `steps`, the open one's number as `round`.
describe("a decision that answers the issue's open question", () => {
  const issueRead: AgentQuestion = {
    id: "q1",
    projectId: "p1",
    issueId: "i1",
    status: "open",
    blockerKind: "human",
    steps: [
      { round: 1, prompt: "Which tour runs first?", askedAt: "2026-10-09T00:00:00Z", answerShape: "free_text", needed: "the tour", answeredAt: "2026-10-09T01:00:00Z", answerText: "Sales" },
      { round: 2, prompt: "Which flag guards it?", askedAt: "2026-10-09T02:00:00Z", answerShape: "free_text", needed: "the flag" },
    ],
    round: 2,
    prompt: "Which flag guards it?",
    askedAt: "2026-10-09T02:00:00Z",
    answerShape: "free_text",
    needed: "the flag",
    recommendedOptionId: "",
    locked: false,
    options: [],
    maxRounds: 3,
    voidReason: null,
    endedReason: null,
    parkDeadlineAt: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T02:00:00Z",
  };
  const withQuestion = (c: { method: string; path: string }) =>
    c.method === "GET" && c.path.startsWith("/questions?") ? { body: { questions: [issueRead] } } : undefined;

  it("offers the choice, ticked, and the decision answers the open round", async () => {
    const calls = fakeCore((c) => withQuestion(c) ?? { status: 201, body: decided });
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    const settles = await within(box).findByRole("checkbox", { name: /^This answers the open question/ });
    expect(settles).toBeChecked();
    expect(box).toHaveTextContent("Which flag guards it?");
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship behind the flag");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "the migration is not reversible");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/questions/q1/answer",
        body: { round: 2, text: "ship behind the flag\n\nthe migration is not reversible" },
      }),
    );
    expect(calls).toContainEqual({
      method: "POST",
      path: "/issues/i1/comments",
      body: { intent: "decision", decision: { decision: "ship behind the flag", reason: "the migration is not reversible" } },
    });
  });

  // hop ISS-185 had two: the person names which one the decision answers, or none
  it("with two open, asks which one it answers and answers only that one", async () => {
    const other: AgentQuestion = { ...issueRead, id: "q2", steps: [{ round: 1, prompt: "Does it show on a phone?", askedAt: "2026-10-09T03:00:00Z", answerShape: "free_text", needed: "yes or no" }], round: 1, prompt: "Does it show on a phone?" };
    const calls = fakeCore((c) =>
      c.method === "GET" && c.path.startsWith("/questions?") ? { body: { questions: [issueRead, other] } } : { status: 201, body: decided },
    );
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    const which = within(await within(box).findByTestId("settles-which"));
    expect(which.getByRole("radio", { name: "Which flag guards it?" })).toBeChecked();
    await user.click(which.getByRole("radio", { name: "Does it show on a phone?" }));
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "yes");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "reps use phones");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/questions/q2/answer", body: { round: 1, text: "yes\n\nreps use phones" } }));
    expect(calls.filter((c) => c.path === "/questions/q1/answer")).toEqual([]);
  });

  it("with None picked, records the decision and answers no question", async () => {
    const other: AgentQuestion = { ...issueRead, id: "q2", round: 1, prompt: "Does it show on a phone?" };
    const calls = fakeCore((c) =>
      c.method === "GET" && c.path.startsWith("/questions?") ? { body: { questions: [issueRead, other] } } : { status: 201, body: decided },
    );
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.click(await within(box).findByRole("radio", { name: "None of these questions" }));
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship it");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "safe");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/issues/i1/comments")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.path.endsWith("/answer"))).toEqual([]);
  });

  it("offers none when the issue has no open question", async () => {
    fakeCore(noOpenQuestion);
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { box } = await openDecisionMode();
    expect(within(box).queryByRole("checkbox")).toBeNull();
  });
});

// HOP ISS-120 and ISS-67 (dev, 2026-10-07): a decision sent while dev answered slowly was lost when the
// page closed three seconds later, before core had read the request. The request outlives the page,
// and leaving while it is in flight asks first.
describe("a decision still being recorded", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function sendHeld() {
    fakeCore((c) => noOpenQuestion(c) ?? HANG);
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship it");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "because");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(sent()).toBeDefined());
  }

  const sent = () => vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")?.[1];

  it("is sent as a request that outlives the page", async () => {
    await sendHeld();
    expect(sent()?.keepalive).toBe(true);
  });

  it("asks before the page is left while it is in flight", async () => {
    await sendHeld();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });
});

describe("a decision in the thread", () => {
  it("wears the Decision badge", () => {
    fakeCore(() => undefined);
    renderWithQuery(<CommentThread issueId="i1" comments={[decided]} members={[]} readOnly />);
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });

  // The live QA (2026-10-08): owner rulings posted from the web read as questions to the master, and
  // nothing set them apart in the thread. A decision now sits behind an accent bar; talk does not.
  it("is drawn apart from the talk, and a question is not", () => {
    fakeCore(() => undefined);
    const asked = { ...decided, id: "c2", intent: "question", decision: null, body: "Which flag?" } as unknown as CommentNode;
    renderWithQuery(<CommentThread issueId="i1" comments={[decided, asked]} members={[]} readOnly />);
    const bars = screen.getAllByTestId("thread-decision");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveTextContent("ship behind the flag");
    expect(bars[0]).not.toHaveTextContent("Which flag?");
  });
});

// The same QA: the composer sent no intent, so core stored every person's comment as a `question`
// the master then owed a reply to. The composer says what the comment is and sends it by name.
describe("what a comment on an issue is", () => {
  it("is sent as a question by default and as a note when Note is picked", async () => {
    const calls = fakeCore(() => ({ status: 201, body: { id: "c9" } }));
    const user = userEvent.setup();
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    await user.type(screen.getByPlaceholderText("Ask a question…"), "Which flag guards it?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/issues/i1/comments", body: { body: "Which flag guards it?", intent: "question" } }));
    await user.click(screen.getByRole("button", { name: "Note" }));
    await user.type(await screen.findByPlaceholderText("Add a note…"), "Verified on dev.185.");
    await user.click(screen.getByRole("button", { name: "Post note" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/issues/i1/comments", body: { body: "Verified on dev.185.", intent: "note" } }));
  });
});
