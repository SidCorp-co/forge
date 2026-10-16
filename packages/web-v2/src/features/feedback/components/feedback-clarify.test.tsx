// Asking the reporter one clarification: offered exactly where core's read says the route takes one
// (`can.clarify`), sending the question and what is needed back; a refusal lands on its field.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { ClarifyReporter } from "./feedback-clarify";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const CAN = { triage: true, drop: true, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: true, message: true, tellShipped: false, note: true, attach: false, clarify: true };
const view = (clarify: boolean): FeedbackView => ({ id: "f1", key: "FB-4", phase: "new", can: { ...CAN, clarify } }) as unknown as FeedbackView;

function open() {
  fireEvent.click(screen.getByTestId("feedback-clarify-open"));
  fireEvent.change(screen.getByTestId("feedback-clarify-prompt"), { target: { value: " Which browser? " } });
  fireEvent.change(screen.getByTestId("feedback-clarify-needed"), { target: { value: " Browser and version " } });
}

describe("asking the reporter a clarification", () => {
  it("is not offered where core says the route would refuse it", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ClarifyReporter projectId="p1" f={view(false)} />);
    expect(screen.queryByTestId("feedback-clarify")).toBeNull();
    expect(screen.queryByTestId("feedback-clarify-open")).toBeNull();
  });

  it("sends the question and what is needed back, trimmed, to the item's clarification route", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: { feedback: {} } } : { body: {} }));
    renderWithQuery(<ClarifyReporter projectId="p1" f={view(true)} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/projects/p1/feedback/FB-4/clarification");
    expect(post?.body).toEqual({ prompt: "Which browser?", needed: "Browser and version" });
    await waitFor(() => expect(screen.getByTestId("feedback-clarify-open")).toBeInTheDocument());
  });

  it("will not send with either field blank", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ClarifyReporter projectId="p1" f={view(true)} />);
    fireEvent.click(screen.getByTestId("feedback-clarify-open"));
    fireEvent.change(screen.getByTestId("feedback-clarify-prompt"), { target: { value: "Which browser?" } });
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  });

  it("shows core's refusal on the field it names and keeps what was typed", async () => {
    fakeCore((c) =>
      c.method === "POST"
        ? { status: 409, body: { error: { code: "FEEDBACK_CLARIFICATION_OPEN", message: "refused", refusals: [{ code: "FEEDBACK_CLARIFICATION_OPEN", path: "/prompt", detail: "A clarification is already open." }] } } }
        : { body: {} },
    );
    renderWithQuery(<ClarifyReporter projectId="p1" f={view(true)} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText("A clarification is already open.")).toBeInTheDocument();
    expect(screen.getByTestId<HTMLTextAreaElement>("feedback-clarify-prompt").value).toBe(" Which browser? ");
  });
});
