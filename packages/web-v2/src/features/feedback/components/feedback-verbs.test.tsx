// Triage in four verbs and messages to reporters: each verb opens one form that sends exactly what core
// takes; a message previews the exact notice before it is sent; an internal note is marked and says it
// is never sent; the fix's confirmation names who and when, or that Forge confirmed it.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackFacts } from "./feedback-facts";
import { Messages } from "./feedback-messages";
import { TriageVerbs, snoozeUntil } from "./feedback-verbs";

afterEach(() => vi.unstubAllGlobals());

const CAN = { triage: true, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, accept: true, snooze: true, message: true, note: true };
const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-4",
    kind: "bug",
    severity: "medium",
    phase: "new",
    status: "new",
    attentionGroup: "needs_you",
    waitingOn: { kind: "you", who: "You", act: "triage it", rule: "r", ref: null, dueAt: null },
    target: { type: "screen", key: "The board", title: null },
    route: null,
    reporter: { id: "u9", name: "Ana", agency: "human" },
    whereSeen: null,
    duplicates: [],
    source: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: CAN,
    openSuggestions: 0,
    reporters: [{ id: "u9", name: "Ana", agency: "human", from: null }],
    messages: [],
    verified: null,
    autoVerify: null,
    snoozed: null,
    shipNotice: null,
    attachments: [],
    decisions: [],
    ...over,
  }) as unknown as FeedbackView;

const LISTS = {
  feedback: [
    { key: "FB-4", title: "The board loses my filter", phase: "new" },
    { key: "FB-2", title: "Export drops the last row", phase: "new" },
    { key: "FB-1", title: "Old and declined", phase: "declined" },
  ],
  counts: {},
  sensitive: false,
};
const core = (reply: (c: { method: string; path: string; body?: unknown }) => { body: unknown } | undefined = () => undefined) =>
  fakeCore((c) => reply(c) ?? (c.path === "/projects/p1/feedback" ? { body: LISTS } : c.path === "/projects/p1/requirements" ? { body: { requirements: [{ key: "REQ-3", title: "The board keeps its filter" }] } } : { body: { feedback: view() } }));
const posts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "POST");

describe("the four verbs", () => {
  it("offers Accept, Decline, Duplicate and Snooze on a new item, and none where core says it may not", () => {
    core();
    const { unmount } = renderWithQuery(<TriageVerbs projectId="p1" f={view()} />);
    for (const name of ["Accept", "Decline", "Duplicate of…", "Snooze…"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    unmount();
    renderWithQuery(<TriageVerbs projectId="p1" f={view({ can: { ...CAN, accept: false } })} />);
    expect(screen.queryByTestId("feedback-verbs")).toBeNull();
  });

  it("accepts as it stands, or linked to the requirement picked by title", async () => {
    const calls = core();
    renderWithQuery(<TriageVerbs projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(within(screen.getByTestId("verb-accept")).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/feedback/FB-4/accept", body: {} }]));
  });

  it("names an unmatched requirement and sends nothing", async () => {
    const calls = core();
    renderWithQuery(<TriageVerbs projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Requirement" }), { target: { value: "Nothing like it" } });
    await screen.findByTestId("verb-unmatched");
    expect(within(screen.getByTestId("verb-accept")).getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(posts(calls)).toEqual([]);
  });

  it("declines only with a reason, which is what it sends", async () => {
    const calls = core();
    renderWithQuery(<TriageVerbs projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    const decline = within(screen.getByTestId("verb-decline")).getByRole("button", { name: "Decline" });
    expect(decline).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Brand guide says no." } });
    fireEvent.click(decline);
    await waitFor(() =>
      expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/feedback/FB-4/triage", body: { route: "decline", note: "Brand guide says no." } }]),
    );
  });

  it("snoozes to the day picked with its reason, as an instant core is sent", async () => {
    const calls = core();
    renderWithQuery(<TriageVerbs projectId="p1" f={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Snooze…" }));
    const go = within(screen.getByTestId("verb-snooze")).getByRole("button", { name: "Snooze" });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "2099-01-05" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Why snooze" }), { target: { value: "Wait for 0.5" } });
    fireEvent.click(go);
    await waitFor(() =>
      expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/feedback/FB-4/snooze", body: { until: snoozeUntil("2099-01-05"), reason: "Wait for 0.5" } }]),
    );
  });

  it("shows a snoozed item as snoozed until its date", () => {
    renderWithQuery(<FeedbackFacts f={view({ snoozed: { until: "2099-01-05T02:00:00.000Z", reason: "Wait for 0.5" } })} slug="hop" />);
    expect(screen.getByTestId("snoozed-until")).toHaveTextContent("Snoozed until");
    expect(screen.getByTestId("snoozed-until")).toHaveTextContent("Wait for 0.5");
  });
});

describe("messages to reporters", () => {
  const merged = view({
    reporters: [
      { id: "u9", name: "Ana", agency: "human", from: null },
      { id: "u8", name: "Bo", agency: "human", from: "FB-5" },
    ],
  });
  const PREVIEW = {
    audience: "all_reporters",
    title: "A message about FB-4: The board loses my filter",
    body: "We are fixing it this week.",
    recipients: [{ id: "u9", name: "Ana" }, { id: "u8", name: "Bo" }],
    notReached: [],
  };

  it("previews the exact notice before it sends, and sends that text to that audience", async () => {
    const calls = core((c) => (c.path.endsWith("/messages/preview") ? { body: { preview: PREVIEW } } : c.path.endsWith("/messages") ? { body: { feedback: merged } } : undefined));
    renderWithQuery(<Messages projectId="p1" f={merged} />);
    fireEvent.click(screen.getByRole("radio", { name: /Every reporter merged into it/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "We are fixing it this week." } });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const shown = await screen.findByTestId("message-preview");
    expect(shown).toHaveTextContent("A message about FB-4: The board loses my filter");
    expect(shown).toHaveTextContent("We are fixing it this week.");
    expect(shown).toHaveTextContent("To Ana, Bo");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(posts(calls).map((c) => [c.path, c.body])).toEqual([
        ["/projects/p1/feedback/FB-4/messages/preview", { audience: "all_reporters", text: "We are fixing it this week." }],
        ["/projects/p1/feedback/FB-4/messages", { audience: "all_reporters", text: "We are fixing it this week." }],
      ]),
    );
  });

  it("drops a preview the moment the text changes, so Send is never for words nobody saw", async () => {
    core((c) => (c.path.endsWith("/messages/preview") ? { body: { preview: PREVIEW } } : undefined));
    renderWithQuery(<Messages projectId="p1" f={merged} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "One" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByTestId("message-preview");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Two" } });
    expect(screen.queryByTestId("message-preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("marks an internal note as members-only, says it is never sent, and sends it with no preview", async () => {
    const note = { id: "m1", audience: "internal", text: "Call Ana first.", sentBy: "u1", sentByName: "Dana", sentAgency: "human", sentAt: "2026-10-07T01:00:00.000Z", recipients: [] };
    const calls = core((c) => (c.path.endsWith("/messages") ? { body: { feedback: merged } } : undefined));
    renderWithQuery(<Messages projectId="p1" f={view({ messages: [note] as FeedbackView["messages"], reporters: merged.reporters })} />);
    expect(screen.getByTestId("feedback-note")).toHaveTextContent("Internal note · members only");
    expect(screen.getByTestId("feedback-note")).toHaveTextContent("Call Ana first.");
    fireEvent.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByTestId("feedback-composer")).toHaveTextContent("never sent to a reporter");
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Internal note" }), { target: { value: "Second look." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/feedback/FB-4/messages", body: { audience: "internal", text: "Second look." } }]));
  });

  it("offers nothing to write to someone who may neither message nor note, and shows no empty thread", () => {
    renderWithQuery(<Messages projectId="p1" f={view({ can: { ...CAN, message: false, note: false } })} />);
    expect(screen.queryByTestId("feedback-messages")).toBeNull();
  });
});

describe("the confirmation of the fix", () => {
  it("names who verified it and when, or that Forge did after the window", () => {
    const { unmount } = renderWithQuery(<FeedbackFacts f={view({ phase: "verified", status: "verified", attentionGroup: "done", verified: { at: "2026-10-07T01:00:00.000Z", how: "person", by: "u5", byName: "Chi", byReporter: false, reason: null } })} slug="hop" />);
    expect(screen.getByTestId("verified-line")).toHaveTextContent("Verified by Chi");
    unmount();
    renderWithQuery(
      <FeedbackFacts
        f={view({ phase: "verified", status: "verified", attentionGroup: "done", verified: { at: "2026-10-07T01:00:00.000Z", how: "automatic", by: null, byName: null, byReporter: false, reason: "Verified automatically after 7 days with no reply" } })}
        slug="hop"
      />,
    );
    expect(screen.getByTestId("verified-line")).toHaveTextContent("Verified automatically");
    expect(screen.getByTestId("verified-line")).toHaveTextContent("after 7 days with no reply");
  });

  it("says when Forge will verify a resolved item nobody has confirmed", () => {
    renderWithQuery(<FeedbackFacts f={view({ phase: "resolved", autoVerify: { at: "2026-10-14T01:00:00.000Z", windowDays: 7 } })} slug="hop" />);
    expect(screen.getByTestId("facts-auto-verify")).toHaveTextContent("7-day window");
  });
});
