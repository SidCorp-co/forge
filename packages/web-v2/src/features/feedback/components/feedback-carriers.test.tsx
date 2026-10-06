// ISS-265: an item delivered by several issues names every one. Its page lists each carrier with its
// own status, and linking issues in the triage sends every key typed.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackActions, issueKeysOf } from "./feedback-actions";
import { FeedbackFacts } from "./feedback-facts";

const NONE = { triage: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false };

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-1",
    kind: "bug",
    severity: "medium",
    phase: "planned",
    status: "triaged",
    attentionGroup: "moving",
    waitingOn: { kind: "issue", who: "ISS-4 and ISS-7", act: "ship", rule: "planned: its issues carry it", ref: "ISS-4", dueAt: null },
    target: { type: "screen", key: "The board", title: null },
    route: null,
    reporter: { id: "u1", name: "Ana", agency: "human" },
    whereSeen: null,
    duplicates: [],
    source: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: NONE,
    openSuggestions: 0,
    ...over,
  }) as FeedbackView;

afterEach(() => vi.unstubAllGlobals());

describe("the issues that carry an item", () => {
  it("lists every carrier with its own status", () => {
    const f = view({
      route: {
        route: "issue",
        carriers: [
          { key: "ISS-4", status: "closed" },
          { key: "ISS-7", status: "in_progress" },
          { key: "ISS-9", status: "dropped" },
        ],
        answer: null,
      },
    });
    renderWithQuery(<FeedbackFacts f={f} slug="hop" />);
    const rows = screen.getAllByTestId("facts-route-carrier");
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual(["ISS-4", "ISS-7", "ISS-9"]);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^ISS-4.*Closed/i),
      expect.stringMatching(/^ISS-7.*In progress/i),
      expect.stringMatching(/^ISS-9.*Dropped/i),
    ]);
  });

  it("lists none for an answered item, which nothing carries", () => {
    renderWithQuery(<FeedbackFacts f={view({ route: { route: "answer", carriers: [], answer: "Yes." } })} slug="hop" />);
    expect(screen.queryByTestId("facts-route-carriers")).toBeNull();
    expect(screen.getByText("Yes.")).toBeInTheDocument();
  });
});

describe("linking issues in the triage", () => {
  it("reads one key as one issue and several as a list", () => {
    expect(issueKeysOf("ISS-4")).toBe("ISS-4");
    expect(issueKeysOf(" ISS-4, ISS-7  ISS-9 ")).toEqual(["ISS-4", "ISS-7", "ISS-9"]);
  });

  it("sends every key typed", async () => {
    const calls = fakeCore((c) =>
      c.method === "POST" ? { body: { feedback: view() } } : { body: { suggestions: [], feedback: [], counts: {}, sensitive: false } },
    );
    renderWithQuery(<FeedbackActions projectId="p1" f={view({ phase: "new", status: "new", can: { ...NONE, triage: true } })} />);
    fireEvent.click(screen.getByRole("radio", { name: /Bug: link issues/ }));
    fireEvent.change(screen.getByPlaceholderText("ISS-12, ISS-14"), { target: { value: "ISS-4, ISS-7" } });
    fireEvent.click(screen.getByRole("button", { name: "Route it" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/projects/p1/feedback/FB-1/triage",
      body: { route: "issue", issue: ["ISS-4", "ISS-7"] },
    });
  });
});
