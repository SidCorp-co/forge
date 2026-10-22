// ISS-560 (FB-130): a drop the assistant offers in chat, on an issue holding an open question. The
// card shows the question, it can be answered there, and pressing drops the issue and voids what is
// still open with the person's reason in one act. Core's refusal, which names its own field, never
// reaches the person (the owner was shown it on ISS-549, chat a760cd5f).

import { refusalTitle, refusalType } from "@forge/contracts/refusal";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "@/features/questions";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { useActOffers } from "./act-offers";
import type { ConversationMessage } from "./types";

const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const ISSUE = "a37ef0fd-13e6-4a48-9b6b-76127dc386fc";
const PROMPT = "How should ISS-744 be closed: keep, drop or open?";
const REASON = "the export moved to the reports page";

const asked: AgentQuestion = {
  id: "q1",
  projectId: PROJECT,
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

const offer = {
  v: 1,
  act: "drop",
  effect: "transition",
  projectId: PROJECT,
  issueId: ISSUE,
  key: "ISS-744",
  title: "Old export",
  from: "in_progress",
  to: "dropped",
  reason: REASON,
};

const message = {
  id: "m1",
  blocks: [
    {
      type: "tool",
      toolCall: {
        id: "call-1",
        name: "offer_act",
        output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ offer }) }] }),
      },
    },
  ],
} as unknown as ConversationMessage;

function Thread() {
  const { offersFor } = useActOffers({ messages: [message], progress: null });
  return <>{offersFor("m1")}</>;
}

function refusedForOpenQuestions() {
  const code = "OPEN_QUESTIONS";
  const detail =
    'this issue holds 1 open question (q1), and `dropped` would leave it asking a person for a decision nothing can act on. Answer it first, or send this move again with `voidQuestions: "<why they died with the work>"`, which voids each one with that reason in the same write.';
  const message = `refused, nothing written: ${code} at /: ${detail}`;
  const refusals = [{ to: "dropped", openQuestionIds: ["q1"], code, path: "", detail }];
  return {
    status: 422,
    body: { type: refusalType(code), title: refusalTitle(code), status: 422, detail, code, message, error: { code, message, refusals } },
  };
}

function core(state: { open: AgentQuestion[]; status: string; listed?: number }): Call[] {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path.startsWith("/questions?issueId=")) {
      state.listed = (state.listed ?? 0) + 1;
      return { body: { questions: state.open } };
    }
    if (call.method === "GET" && call.path.startsWith(`/issues/${ISSUE}`)) {
      return { body: { id: ISSUE, projectId: PROJECT, status: state.status, displayId: "ISS-744", title: "Old export" } };
    }
    if (call.method === "POST" && call.path === "/questions/q1/answer") {
      state.open = [];
      return { body: { ...asked, status: "answered" } };
    }
    if (call.method === "POST" && call.path === `/issues/${ISSUE}/transition`) {
      const sent = call.body as { toStatus: string; voidQuestions?: string };
      if (state.open.length > 0 && !sent.voidQuestions?.trim()) return refusedForOpenQuestions();
      state.open = [];
      state.status = sent.toStatus;
      return { body: { id: ISSUE, status: sent.toStatus } };
    }
    return { body: {} };
  });
}

const moves = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/transition")).map((c) => c.body);
const noFieldName = () => expect(document.body.textContent ?? "").not.toMatch(/voidQuestions/);

describe("a chat drop on an issue with an open question (ISS-560)", () => {
  it("shows the question, and one press drops the issue and voids it with the person's reason", async () => {
    const calls = core({ open: [asked], status: "in_progress" });
    const user = userEvent.setup();
    renderWithQuery(<Thread />);

    expect(await screen.findByText(PROMPT)).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(moves(calls)).toEqual([{ toStatus: "dropped", reason: REASON, voidQuestions: REASON }]));
    expect(await screen.findByRole("status")).toBeTruthy();
    noFieldName();
  });

  it("answers a question still worth answering on the card, and the drop then voids nothing", async () => {
    const calls = core({ open: [asked], status: "in_progress" });
    const user = userEvent.setup();
    renderWithQuery(<Thread />);

    await user.type(await screen.findByRole("textbox", { name: /Your answer/ }), "drop it");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(moves(calls)).toEqual([{ toStatus: "dropped", reason: REASON }]));
    noFieldName();
  });

  it("says a question is open, never core's field, when one is asked after the card was drawn", async () => {
    const state: { open: AgentQuestion[]; status: string } = { open: [], status: "in_progress" };
    const calls = core(state);
    const user = userEvent.setup();
    renderWithQuery(<Thread />);

    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    state.open = [asked];
    await user.click(confirm);
    expect(await screen.findByRole("alert")).toBeTruthy();
    noFieldName();
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(moves(calls)).toEqual([
        { toStatus: "dropped", reason: REASON },
        { toStatus: "dropped", reason: REASON, voidQuestions: REASON },
      ]),
    );
  });
});
