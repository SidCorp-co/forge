// ISS-264: an approver corrects what a feedback item is about from its page. The control follows
// core's `can.retarget`, sends exactly the one target typed, and a refusal names its code and keeps
// what was typed.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackActions } from "./feedback-actions";

const NONE = { triage: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, accept: false, snooze: false, message: false, note: false, attach: false };

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-1",
    phase: "verified",
    target: { type: "screen", key: "/projects/hop/workflows", title: null },
    can: { ...NONE, retarget: true },
    openSuggestions: 0,
    reporters: [],
    messages: [],
    verified: null,
    autoVerify: null,
    snoozed: null,
    ...over,
  }) as FeedbackView;

afterEach(() => vi.unstubAllGlobals());

/** The lists the About picker reads beside whatever a test serves: the viewer's projects, and the project's requirements, workflows and releases. */
const REQUIREMENTS = { requirements: [{ key: "REQ-3", title: "The board keeps its cards" }, { key: "REQ-12", title: "Labels" }], returned: 2 };
const lists = (c: { path: string }) =>
  c.path === "/projects"
    ? { body: [{ id: "p1", role: "member" }] }
    : c.path === "/projects/p1/requirements"
      ? { body: REQUIREMENTS }
      : c.path === "/projects/p1/workflows"
        ? { body: { workflows: [{ document: { flow: "sign-in", title: "Signing in" } }], returned: 1 } }
        : c.path === "/projects/p1/releases"
          ? { body: { releases: [{ version: "0.1.0" }] } }
          : undefined;
const core = (reply: (c: { method: string; path: string; body?: unknown }) => { status?: number; body: unknown } | undefined) =>
  fakeCore((c) => reply(c) ?? lists(c));


async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Change what it is about…" }));
  await screen.findByTestId("feedback-choices");
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "REQ-12" } });
}

describe("changing what a feedback item is about", () => {
  it("is offered where core says the viewer may, and not otherwise", () => {
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    expect(screen.getByTestId("feedback-retarget")).toBeInTheDocument();
  });

  it("picks the requirement by title, sending its key, and refuses text naming none by name", async () => {
    const calls = core((c) => (c.method === "POST" ? { body: { feedback: view() } } : undefined));
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change what it is about…" }));
    await screen.findByTestId("feedback-choices");
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "Nothing like this" } });
    expect(screen.getByTestId("feedback-target-unmatched")).toHaveTextContent("No requirement of this project is titled or keyed “Nothing like this”: pick one from the list.");
    expect(screen.getByRole("button", { name: "Move it" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "labels" } });
    expect(screen.queryByTestId("feedback-target-unmatched")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move it" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ requirement: "REQ-12" }));
  });

  it("is not offered to a reader core says may not", () => {
    renderWithQuery(<FeedbackActions projectId="p1" f={view({ can: NONE })} />);
    expect(screen.queryByTestId("feedback-retarget")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change what it is about…" })).toBeNull();
  });

  it("sends the one target typed and shows the item's new target", async () => {
    const calls = core((c) =>
      c.method === "POST" ? { body: { feedback: view({ target: { type: "requirement", key: "REQ-12", title: "Labels" } }) } } : undefined,
    );
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    await open();
    fireEvent.change(screen.getByLabelText("Why (optional)"), { target: { value: "now a criterion" } });
    fireEvent.click(screen.getByRole("button", { name: "Move it" }));
    await waitFor(() => expect(screen.getByText("Now about requirement REQ-12.")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/projects/p1/feedback/FB-1/retarget",
      body: { requirement: "REQ-12", reason: "now a criterion" },
    });
  });

  // ISS-279's judge: the label was lower-cased whole, so it read "api route or tool"
  it("names a route or tool target with the label's own casing", () => {
    renderWithQuery(<FeedbackActions projectId="p1" f={view({ target: { type: "endpoint", key: "shop-tools:save_backend_workflow", title: null } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Change what it is about…" }));
    expect(screen.getByText("Now API route or tool shop-tools:save_backend_workflow. Its route and phase stay as they are; the move is kept in its history.")).toBeInTheDocument();
  });

  it("tells the mover before Move it that a project serving nothing has no route or tool to name", async () => {
    core((c) => (c.path.endsWith("/endpoints") ? { body: { endpoints: [] } } : undefined));
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change what it is about…" }));
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "endpoint" } });
    expect(await screen.findByTestId("feedback-endpoints-none")).toHaveTextContent("File it as a Screen instead.");
  });

  it("shows a refusal by its code and keeps what was typed", async () => {
    core((c) => c.method !== "POST" ? undefined : ({
      status: 422,
      body: {
        error: {
          code: "FEEDBACK_REFUSED",
          message: "refused",
          refusals: [{ code: "FEEDBACK_TARGET_UNCHANGED", path: "/requirement", detail: "FB-1 is already about requirement REQ-12" }],
        },
      },
    }));
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Move it" }));
    const line = await screen.findByTestId("refusal");
    expect(line).toHaveTextContent("FEEDBACK_TARGET_UNCHANGED");
    expect(line).toHaveTextContent("FB-1 is already about requirement REQ-12");
    expect(screen.getByLabelText("Target")).toHaveValue("REQ-12");
  });
});
