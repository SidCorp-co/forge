// The answer panel on an issue (ISS-257, ISS-258): an answer can say the issue still waits, sent as
// `stillWaits`; an answered card shows what the issue still waits on and what the answer did to it.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { AgentQuestion, QuestionStep } from "../types";
import { DecisionPanel } from "./decision-panel";

const asked: AgentQuestion = {
  id: "q1",
  projectId: "p1",
  issueId: "i1",
  status: "open",
  blockerKind: "human",
  steps: [
    {
      round: 1,
      prompt: "Which flow ships first?",
      askedAt: "2026-10-06T00:00:00Z",
      answerShape: "free_text",
      needed: "the flow that ships first",
    },
  ],
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z",
  answerShape: "free_text",
  options: [],
  recommendedOptionId: "",
  needed: "the flow that ships first",
  locked: false,
};

const answered: AgentQuestion = {
  ...asked,
  status: "answered",
  steps: [
    {
      round: 1,
      prompt: "Which flow ships first?",
      askedAt: "2026-10-06T00:00:00Z",
      answerShape: "free_text",
      needed: "the flow that ships first",
      answeredAt: "2026-10-06T01:00:00Z",
      answerText: "intake",
      hold: { reason: "the intake design lands first", blockedBy: { id: "i2", key: "ISS-12" } },
      resume: { kind: "held", at: "2026-10-06T01:00:01Z" },
    } satisfies QuestionStep,
  ],
};

describe("answering a question on an issue", () => {
  it("sends what the issue still waits on, and the blocking issue picked by its title, with the answer", async () => {
    const calls = fakeCore((call) =>
      call.path.includes("/issues/search")
        ? { body: { items: [{ id: "i12", displayId: "ISS-12", title: "Intake design" }], total: 1 } }
        : call.method === "GET"
          ? { body: { questions: [asked] } }
          : { body: { ...answered } },
    );
    renderWithQuery(<DecisionPanel issueId="i1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "The issue still waits after this answer" }));
    await user.type(screen.getByRole("textbox", { name: /Your answer/ }), "intake");
    await user.type(screen.getByRole("textbox", { name: /What it still waits on/ }), " the intake design lands first ");
    await user.type(screen.getByRole("combobox", { name: "Blocked by issue" }), "intake");
    await user.click(await screen.findByRole("option", { name: /ISS-12/ }));
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/questions/q1/answer",
        body: {
          text: "intake",
          round: 1,
          stillWaits: { reason: "the intake design lands first", blockedBy: "ISS-12" },
        },
      }),
    );
  });

  it("will not send a still-waits answer that does not say what it waits on", async () => {
    const calls = fakeCore(() => ({ body: { questions: [asked] } }));
    renderWithQuery(<DecisionPanel issueId="i1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "The issue still waits after this answer" }));
    await user.type(screen.getByRole("textbox", { name: /Your answer/ }), "intake");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByText("Say what the issue still waits on, or untick the box.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("sends a plain answer without stillWaits", async () => {
    const calls = fakeCore((call) =>
      call.method === "GET" ? { body: { questions: [asked] } } : { body: { ...answered } },
    );
    renderWithQuery(<DecisionPanel issueId="i1" />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: /Your answer/ }), "intake");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/questions/q1/answer",
        body: { text: "intake", round: 1 },
      }),
    );
  });

  it("shows on an answered card what the issue still waits on and what the answer did", async () => {
    fakeCore(() => ({ body: { questions: [answered] } }));
    renderWithQuery(<DecisionPanel issueId="i1" />);
    expect(await screen.findByText("Still waits on ISS-12: the intake design lands first")).toBeTruthy();
    expect(screen.getByTestId("answer-resume").textContent).toBe(
      "The issue stays parked, as this answer said.",
    );
    expect(screen.queryByTestId("still-waits")).toBeNull();
  });
});
