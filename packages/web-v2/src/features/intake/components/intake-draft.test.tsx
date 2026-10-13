// REQ-34 BC-12..BC-16 (ISS-455): the intake assistant's draft on an item's page, as core keeps it.
// Each named record is a link to its page, each filled gap names where it came from, each question
// shows its options with what they change and the recommended one, and a draft with nothing to ask
// says so.

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IntakeDraftView } from "../types";
import { IntakeDraft } from "./intake-draft";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const draft = (over: Partial<IntakeDraftView> = {}): IntakeDraftView => ({
  item: { kind: "feedback", key: "FB-7" },
  outcome: "drafted",
  code: null,
  detail: null,
  at: "2026-10-10T08:00:00.000Z",
  model: "stub",
  attempts: 1,
  retrying: false,
  read: { requirements: 3, workflows: 2, feedback: 4, releases: 1 },
  links: [
    { relation: "duplicate", ref: { kind: "feedback", key: "FB-3", title: "Wrong patient" }, why: "Same referral." },
    { relation: "conflict", ref: { kind: "requirement", key: "REQ-1", title: "Referral import" }, why: "BC-1 says the code decides." },
    { relation: "affected_workflow", ref: { kind: "workflow", key: "referral", title: "Referral intake" }, why: "Its match step." },
    { relation: "related_feedback", ref: { kind: "feedback", key: "FB-5", title: "Code dropped" }, why: "The lost code." },
  ],
  assumptions: [{ field: "severity", value: "high", source: { kind: "release", key: "1.2.0", title: "1.2.0" } }],
  questions: [
    {
      prompt: "Does an uncoded referral wait?",
      changes: "outcome",
      options: [
        { id: "wait", label: "It waits", effect: "A clerk matches it by hand" },
        { id: "bounce", label: "It bounces", effect: "The clinic resends it" },
      ],
      recommended: "wait",
    },
  ],
  nothingToAsk: null,
  notAffected: [],
  applied: { as: "suggestion", suggestionId: "s1" },
  ...over,
});

function shown(view: IntakeDraftView | null, assumptions = true) {
  const calls = fakeCore(() => ({ body: { draft: view } }));
  const out = renderWithQuery(<IntakeDraft projectId="p1" slug="forge" itemKey="FB-7" assumptions={assumptions} />);
  return { calls, ...out };
}

describe("the intake draft on an item's page", () => {
  it("links every record it names, by relation (BC-12)", async () => {
    shown(draft());
    const links = await screen.findAllByTestId("intake-link");
    expect(links.map((l) => l.textContent)).toEqual([
      "DuplicateFB-3 Wrong patient · Same referral.",
      "ConflictREQ-1 Referral import · BC-1 says the code decides.",
      "Affectsreferral Referral intake · Its match step.",
      "RelatedFB-5 Code dropped · The lost code.",
    ]);
    expect(links.map((l) => within(l).getByRole("link").getAttribute("href"))).toEqual([
      "/projects/forge/feedback/FB-3",
      "/projects/forge/requirements/REQ-1",
      "/projects/forge/workflows/referral",
      "/projects/forge/feedback/FB-5",
    ]);
  });

  it("names where each filled gap came from (BC-13)", async () => {
    shown(draft());
    const row = await screen.findByTestId("intake-assumption");
    expect(row.textContent).toBe("Severityhigh · From 1.2.0");
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/projects/forge/releases/1.2.0");
  });

  it("shows each question's options with what they change, the recommended one marked (BC-15)", async () => {
    shown(draft());
    const options = await screen.findAllByTestId("intake-option");
    expect(options.map((o) => o.textContent)).toEqual([
      "It waitsRecommended · A clerk matches it by hand",
      "It bounces · The clinic resends it",
    ]);
    expect(options.map((o) => o.dataset.recommended ?? null)).toEqual(["true", null]);
  });

  it("says it has nothing to ask where it asks nothing (BC-16)", async () => {
    shown(draft({ questions: [], nothingToAsk: "The record settles the triage." }));
    expect((await screen.findByTestId("intake-nothing-to-ask")).textContent).toBe("Nothing");
    expect(screen.queryByTestId("intake-question")).toBeNull();
  });

  it("leaves the assumptions to the page that already shows them", async () => {
    shown(draft(), false);
    await screen.findAllByTestId("intake-link");
    expect(screen.queryByTestId("intake-assumption")).toBeNull();
  });

  it("names a draft that could not be made, and shows nothing before one exists", async () => {
    const { calls } = shown(draft({ outcome: "failed", code: "INTAKE_SHAPE", detail: "questions: Too big", links: [], questions: [], assumptions: [] }));
    expect((await screen.findByTestId("intake-failed")).textContent).toBe("Not drafted: answer refused");
    expect(calls.map((c) => c.path)).toEqual(["/projects/p1/intake-drafts/FB-7"]);
    vi.unstubAllGlobals();
    const none = shown(null);
    await waitFor(() => expect(none.calls).toHaveLength(1));
    expect(none.container.querySelector("[data-testid=intake-draft]")).toBeNull();
  });

  it("says a missed draft is being tried again, and when it gave up (J8 FB-123)", async () => {
    const miss: Partial<IntakeDraftView> = { outcome: "failed", code: "INTAKE_MODEL_FAILED", links: [], questions: [], assumptions: [] };
    shown(draft({ ...miss, attempts: 1, retrying: true }));
    expect((await screen.findByTestId("intake-failed")).textContent).toBe("Model failed; retrying, try 2 of 3");
    vi.unstubAllGlobals();
    const gaveUp = shown(draft({ ...miss, attempts: 3, retrying: false }));
    expect((await within(gaveUp.container).findByTestId("intake-failed")).textContent).toBe(
      "Not drafted: model failed · Gave up after 3 tries",
    );
  });
});
