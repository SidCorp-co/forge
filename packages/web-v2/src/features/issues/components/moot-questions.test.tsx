// ISS-560 (FB-130): dropping or closing an issue with an open question is one act. The dialog shows
// the questions the move would end, a question still worth answering is answered there, and the
// move voids the rest with the reason the person typed — never a refusal naming core's field.
// Driven through the real `useGuardedTransition` against a stand-in core answering what core does.

import { refusalTitle, refusalType } from "@forge/contracts/refusal";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "@/features/questions";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import type { IssueStatus } from "../types";
import { useGuardedTransition } from "./use-guarded-transition";

const ISSUE = "8c3a0f3e-5b1e-4f7a-9d55-2f0a8e6b1c49";
const PROMPT = "How should this issue be closed: keep, drop or open?";
const REASON = "superseded by ISS-561, which carries the same fix";

const asked: AgentQuestion = {
  id: "q1",
  projectId: "p1",
  issueId: ISSUE,
  status: "open",
  blockerKind: "human",
  steps: [{ round: 1, prompt: PROMPT, askedAt: "2026-10-21T00:00:00Z", answerShape: "free_text", needed: "how it closes" }],
  round: 1,
  prompt: PROMPT,
  askedAt: "2026-10-21T00:00:00Z",
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  answerShape: "free_text",
  options: [],
  recommendedOptionId: "",
  needed: "how it closes",
  locked: false,
};

/** Core's answer to a terminal move that meets an open question and voids none (`questions/issue-coupling.ts`). */
function refusedForOpenQuestions(to: IssueStatus) {
  const code = "OPEN_QUESTIONS";
  const detail = `this issue holds 1 open question (q1), and \`${to}\` would leave it asking a person for a decision nothing can act on. Answer it first, or send this move again with \`voidQuestions: "<why they died with the work>"\`, which voids each one with that reason in the same write.`;
  const message = `refused, nothing written: ${code} at /: ${detail}`;
  const refusals = [{ to, openQuestionIds: ["q1"], code, path: "", detail }];
  return {
    status: 422,
    body: { type: refusalType(code), title: refusalTitle(code), status: 422, detail, code, message, error: { code, message, refusals } },
  };
}

/**
 * A core holding the issue's questions: the list answers what is open now, an answer ends one, and a
 * close or drop is refused while one is open unless the move voids them with a reason.
 */
function core(state: { open: AgentQuestion[]; listed?: number }): Call[] {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path.startsWith("/questions?issueId=")) {
      state.listed = (state.listed ?? 0) + 1;
      return { body: { questions: state.open } };
    }
    if (call.method === "POST" && call.path === "/questions/q1/answer") {
      state.open = [];
      return { body: { ...asked, status: "answered" } };
    }
    if (call.method === "POST" && call.path.endsWith("/transition")) {
      const sent = call.body as { toStatus: IssueStatus; voidQuestions?: string };
      if (state.open.length > 0 && !sent.voidQuestions?.trim()) return refusedForOpenQuestions(sent.toStatus);
      state.open = [];
      return { body: { id: ISSUE, status: sent.toStatus } };
    }
    return { body: {} };
  });
}

function Harness({ status, to }: { status: IssueStatus; to: IssueStatus }) {
  const guarded = useGuardedTransition();
  return (
    <>
      <button type="button" onClick={() => guarded.requestTransition({ id: ISSUE, status }, to)}>
        Press {to}
      </button>
      {guarded.dialog}
    </>
  );
}

const moves = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/transition")).map((c) => c.body);
const noFieldName = () => expect(document.body.textContent ?? "").not.toMatch(/voidQuestions/);

describe("dropping an issue with an open question (ISS-560)", () => {
  it("shows the question, and one Drop voids it with the reason the person gave", async () => {
    const calls = core({ open: [asked] });
    const user = userEvent.setup();
    renderWithQuery(<Harness status="in_progress" to="dropped" />);

    await user.click(screen.getByRole("button", { name: "Press dropped" }));
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), REASON);
    await user.click(screen.getByRole("button", { name: "Drop" }));

    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expect(moves(calls)).toEqual([{ toStatus: "dropped", reason: REASON, voidQuestions: REASON }]);
    noFieldName();
  });

  it("lets a question still worth answering be answered there, and the drop then voids nothing", async () => {
    const calls = core({ open: [asked] });
    const user = userEvent.setup();
    renderWithQuery(<Harness status="in_progress" to="dropped" />);

    await user.click(screen.getByRole("button", { name: "Press dropped" }));
    await user.type(await screen.findByRole("textbox", { name: /Your answer/ }), "drop it, ISS-561 carries it");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/questions/q1/answer",
        body: { text: "drop it, ISS-561 carries it", round: 1 },
      }),
    );
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());

    await user.type(screen.getByRole("textbox", { name: /Reason/ }), REASON);
    await user.click(screen.getByRole("button", { name: "Drop" }));
    await waitFor(() => expect(moves(calls)).toEqual([{ toStatus: "dropped", reason: REASON }]));
    noFieldName();
  });

  it("keeps the dialog and the reason when a question is asked between the read and the press", async () => {
    const state: { open: AgentQuestion[] } = { open: [] };
    const calls = core(state);
    const user = userEvent.setup();
    renderWithQuery(<Harness status="in_progress" to="dropped" />);

    await user.click(screen.getByRole("button", { name: "Press dropped" }));
    const reason = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: /Reason/ });
    await user.type(reason, REASON);
    state.open = [asked]; // a run asks while the person is typing
    await user.click(screen.getByRole("button", { name: "Drop" }));

    expect(await screen.findByText(PROMPT)).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: /Reason/ }).value).toBe(REASON);
    noFieldName();
    await user.click(screen.getByRole("button", { name: "Drop" }));
    await waitFor(() =>
      expect(moves(calls)).toEqual([
        { toStatus: "dropped", reason: REASON },
        { toStatus: "dropped", reason: REASON, voidQuestions: REASON },
      ]),
    );
  });
});

describe("closing an issue with an open question (ISS-560)", () => {
  it("shows the question the close met, and voids it with the reason given there", async () => {
    const calls = core({ open: [asked] });
    const user = userEvent.setup();
    renderWithQuery(<Harness status="in_progress" to="closed" />);

    await user.click(screen.getByRole("button", { name: "Press closed" }));
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    noFieldName();
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "the design shipped; the question is moot");
    await user.click(screen.getByRole("button", { name: "Withdraw them and continue" }));

    await waitFor(() => expect(moves(calls)).toHaveLength(2));
    expect(moves(calls)).toEqual([
      { toStatus: "closed" },
      { toStatus: "closed", voidQuestions: "the design shipped; the question is moot" },
    ]);
    noFieldName();
  });
});
