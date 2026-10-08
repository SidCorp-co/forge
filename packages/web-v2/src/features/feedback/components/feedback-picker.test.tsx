// Duplicate of: a person routing an item as a duplicate typed the original's FB key blind. The picker
// searches the project's feedback by key and title, lists the item an exact key names first, and never
// offers the item itself or a declined one (core refuses those as FEEDBACK_DUPLICATE_OF_DECLINED).

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackActions } from "./feedback-actions";
import { TriageVerbs } from "./feedback-verbs";

afterEach(() => vi.unstubAllGlobals());

const CAN = { triage: true, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, accept: false, snooze: false, message: false, tellShipped: false, note: false, attach: false };
const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f4",
    key: "FB-4",
    title: "The board loses my filter",
    kind: "bug",
    severity: "medium",
    phase: "new",
    attentionGroup: "needs_you",
    waitingOn: { kind: "you", who: "You", act: "triage it", rule: "r", ref: null },
    target: { type: "screen", key: "The board", title: null },
    route: null,
    reporter: { id: "u9", name: "Ana", agency: "human" },
    reporters: [],
    duplicates: [],
    decisions: [],
    messages: [],
    attachments: [],
    can: CAN,
    openSuggestions: 0,
    ...over,
  }) as unknown as FeedbackView;

const LIST = {
  feedback: [
    { key: "FB-4", title: "The board loses my filter", phase: "new" },
    { key: "FB-12", title: "Board filter resets on reload", phase: "new" },
    { key: "FB-1", title: "Filter chips overlap", phase: "triaged" },
    { key: "FB-2", title: "Board filter, declined long ago", phase: "declined" },
  ],
  counts: {},
  sensitive: false,
};

const core = () =>
  fakeCore((c) => (c.path === "/projects/p1/feedback" ? { body: LIST } : c.method === "POST" ? { body: { feedback: view() } } : undefined));

const optionKeys = () => screen.getAllByRole("option").map((o) => o.textContent?.match(/FB-\d+/)?.[0]);

describe("the duplicate-of picker", () => {
  it("replaces the typed key box on the triage form, and lists an exact key first", async () => {
    core();
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Duplicate of an item/ }));
    expect(screen.queryByPlaceholderText("FB-3")).toBeNull();
    await userEvent.type(screen.getByRole("combobox", { name: "Original" }), "fb-1");
    await waitFor(() => expect(optionKeys()).toEqual(["FB-1", "FB-12"]));
  });

  it("finds items by words of their title, never the item itself or a declined one", async () => {
    core();
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Duplicate of an item/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Original" }), "filter");
    await waitFor(() => expect(optionKeys()).toEqual(["FB-12", "FB-1"]));
  });

  it("says nothing matched rather than leaving an empty list", async () => {
    core();
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Duplicate of an item/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Original" }), "zebra");
    await waitFor(() => expect(screen.getByText("No open feedback item matches “zebra”")).toBeTruthy());
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("routes the triage form's duplicate to the key picked", async () => {
    const calls = core();
    renderWithQuery(<FeedbackActions projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Duplicate of an item/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Original" }), "reload");
    await userEvent.click(await screen.findByRole("option", { name: /FB-12/ }));
    fireEvent.click(screen.getByRole("button", { name: "Route it" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/feedback/FB-4/triage", body: { route: "duplicate", duplicateOf: "FB-12" } },
      ]),
    );
  });

  it("marks the Duplicate of verb with the key picked, with Mark duplicate off until one is", async () => {
    const calls = core();
    renderWithQuery(<TriageVerbs projectId="p1" f={view({ can: { ...CAN, accept: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate of…" }));
    const go = within(screen.getByTestId("verb-duplicate")).getByRole("button", { name: "Mark duplicate" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByRole("combobox", { name: "Original" }), "FB-1");
    await userEvent.click(await screen.findByRole("option", { name: /FB-1(?!\d)/ }));
    fireEvent.click(go);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/feedback/FB-4/triage", body: { route: "duplicate", duplicateOf: "FB-1" } },
      ]),
    );
  });
});
