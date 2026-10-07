// ISS-265: an item delivered by several issues names every one. Its page lists each carrier with its
// own status, and linking issues in the triage sends every issue picked, never a key typed blind.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { forecastWait, say, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { FeedbackActions, issueKeysOf } from "./feedback-actions";
import { FeedbackFacts } from "./feedback-facts";

const NONE = { triage: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, accept: false, snooze: false, message: false, note: false, attach: false };

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-1",
    kind: "bug",
    severity: "medium",
    phase: "planned",
    status: "triaged",
    attentionGroup: "moving",
    waitingOn: waitingOn("issue", { who: say("standing.keysAnd", { keys: "ISS-4", last: "ISS-7" }), act: say("standing.act.ship"), rule: say("feedback.rule.issuesCarry") }, { ref: "ISS-4" }),
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
    reporters: [],
    messages: [],
    verified: null,
    autoVerify: null,
    snoozed: null,
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

describe("the item's line as its reporter means done", () => {
  const stamp = { label: "forecast" as const, asOf: new Date().toISOString() };

  it("says a fixed item still unreleased waits on whoever cuts the release", () => {
    const forecast = {
      key: "FB-1",
      triage: null,
      delivery: {
        ...stamp,
        landing: { ...stamp, kind: "landed" as const, landedAt: stamp.asOf },
        release: { kind: "person" as const, mode: "manual" as const, ...forecastWait(say("standing.who.holderOf", { perm: "project.admin" }), say("standing.act.cut", { v: "0.4.0", more: null }), say("forecast.reason.manual")), version: "0.4.0", holders: [] },
        inHands: null,
        shipped: null,
      },
    };
    renderWithQuery(<FeedbackFacts f={view()} slug="hop" forecast={forecast} />);
    expect(screen.getByTestId("feedback-forecast-line").textContent).toBe("Fixed · waits on A holder of project.admin to cut 0.4.0");
  });

  it("draws no forecast fact where the item carries no work that ships", () => {
    renderWithQuery(<FeedbackFacts f={view()} slug="hop" forecast={{ key: "FB-1", triage: null, delivery: null }} />);
    expect(screen.queryByTestId("facts-feedback-forecast")).toBeNull();
  });
});

describe("linking issues in the triage", () => {
  it("reads one pick as one issue and several as a list", () => {
    expect(issueKeysOf([{ key: "ISS-4", title: "a" }])).toBe("ISS-4");
    expect(issueKeysOf([{ key: "ISS-4", title: "a" }, { key: "ISS-7", title: "b" }])).toEqual(["ISS-4", "ISS-7"]);
  });

  it("picks the issues by key or title and sends every one picked, offering no box to type keys into", async () => {
    const rows = [
      { id: "i4", displayId: "ISS-4", title: "Cards vanish on drag" },
      { id: "i7", displayId: "ISS-7", title: "Cards vanish on reload" },
    ];
    const calls = fakeCore((c) =>
      c.method === "POST"
        ? { body: { feedback: view() } }
        : c.path.startsWith("/projects/p1/issues/search")
          ? { body: { items: rows, total: rows.length } }
          : { body: { suggestions: [], feedback: [], counts: {}, sensitive: false } },
    );
    renderWithQuery(<FeedbackActions projectId="p1" f={view({ phase: "new", status: "new", can: { ...NONE, triage: true } })} />);
    fireEvent.click(screen.getByRole("radio", { name: /Bug: link issues/ }));
    expect(screen.queryByPlaceholderText("ISS-12, ISS-14")).toBeNull();
    expect(screen.getByRole("button", { name: "Route it" })).toBeDisabled();
    const picker = screen.getByRole("combobox", { name: "Issues that carry it" });
    await userEvent.type(picker, "vanish");
    await userEvent.click(await screen.findByRole("option", { name: /ISS-4/ }));
    await userEvent.type(picker, "vanish");
    await userEvent.click(await screen.findByRole("option", { name: /ISS-7/ }));
    fireEvent.click(screen.getByRole("button", { name: "Route it" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/projects/p1/feedback/FB-1/triage",
      body: { route: "issue", issue: ["ISS-4", "ISS-7"] },
    });
  });
});
