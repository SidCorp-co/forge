// REQ-65 BC-1..BC-6, REQ-66 BC-2 (ISS-690): a request's one value check on its page. Each fact names
// where it came from, the outcome is a badge and one line, a blocking question is answered by a chip and
// held until then, an assumed answer says so, and a refused requirement is kept with a one-line reason.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IntakeDraftView, IntakeQuestionView, ValueCheckView } from "../types";
import { ValueCheck } from "./value-check";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const REQ = { kind: "requirement" as const, key: "REQ-9", title: "Match referrals" };
const question = (over: Partial<IntakeQuestionView> = {}): IntakeQuestionView => ({
  number: 1,
  prompt: "How often is the report wanted?",
  changes: "scope",
  options: [
    { id: "weekly", label: "Weekly", effect: "One report a week" },
    { id: "monthly", label: "Monthly", effect: "One report a month" },
  ],
  recommended: "weekly",
  blocks: null,
  answer: null,
  ...over,
});
const value = (over: Partial<ValueCheckView> = {}): ValueCheckView => ({
  who: { value: "Clinic clerks", source: REQ },
  improves: { value: "Each referral reaches its patient", source: REQ },
  measured: { value: "Weekly", source: { kind: "recommended", question: 1 } },
  exists: null,
  outcome: { kind: "accept" },
  kept: null,
  effect: null,
  ...over,
});
const draft = (over: Partial<IntakeDraftView> = {}): IntakeDraftView => ({
  item: { kind: "requirement", key: "REQ-9" },
  outcome: "drafted",
  code: null,
  detail: null,
  at: "2026-10-25T08:00:00.000Z",
  model: "stub",
  attempts: 1,
  retrying: false,
  read: { requirements: 3, workflows: 1, feedback: 0, releases: 0 },
  links: [],
  notAffected: [],
  assumptions: [],
  questions: [question()],
  answered: [],
  nothingToAsk: null,
  applied: { as: "none", code: "INTAKE_NOTHING_TO_FILL", detail: "" },
  value: value(),
  can: { answer: true, keep: false },
  ...over,
});

function shown(view: IntakeDraftView | null, write?: (body: unknown, path: string) => { status?: number; body: unknown }) {
  const calls = fakeCore((c) => (c.method === "POST" && write ? write(c.body, c.path) : { body: { draft: view } }));
  const out = renderWithQuery(<ValueCheck projectId="p1" slug="forge" itemKey={view?.item.key ?? "REQ-9"} />);
  return { calls, ...out };
}

describe("a request's value check on its page", () => {
  it("names who it is for, what improves, how it is measured and where each came from (BC-1)", async () => {
    shown(draft());
    expect((await screen.findByTestId("value-who")).textContent).toBe("Who it is forClinic clerks · From REQ-9");
    expect(screen.getByTestId("value-measured").textContent).toBe("Measured byWeekly · Recommended answer to question 1");
    expect(screen.getByTestId("value-exists").textContent).toBe("Already existsNone found");
    expect(screen.getByTestId("value-check").dataset.outcome).toBe("accept");
    expect(screen.getByTestId("value-outcome").textContent).toBe("AcceptedWorth doing as asked");
  });

  it("shows a merge into what it repeats, linked, and that an approver confirms it (BC-2)", async () => {
    const into = { kind: "requirement" as const, key: "REQ-1", title: "Referral import" };
    shown(draft({ value: value({ exists: { ref: into, why: "Same clinic-code match." }, outcome: { kind: "merge", into, why: "One rule." }, effect: { as: "suggestion", suggestionId: "s1" } }) }));
    const row = await screen.findByTestId("value-outcome");
    expect(row.textContent).toBe("MergeInto REQ-1 · One rule. · Proposed; an approver confirms");
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/projects/forge/requirements/REQ-1");
    expect(screen.getByTestId("value-exists").textContent).toBe("Already existsREQ-1 Referral import · Same clinic-code match.");
  });

  it("shows a refusal's one-line reason, and keeps it with the person's one line (BC-2, BC-6)", async () => {
    const refused = draft({ value: value({ outcome: { kind: "refuse", reason: "It names nobody it helps." }, effect: { as: "refused" } }), can: { answer: true, keep: true } });
    const kept = draft({ value: value({ outcome: refused.value?.outcome ?? null, kept: { reason: "The board asked for it.", by: { id: "u1", name: "Ann" }, at: "2026-10-25T09:00:00.000Z" } }) });
    const { calls } = shown(refused, () => ({ body: { draft: kept } }));
    expect((await screen.findByTestId("value-reason")).textContent).toBe("It names nobody it helps.");
    expect(screen.getByTestId("value-check").dataset.outcome).toBe("refuse");
    const keep = screen.getByTestId("value-keep");
    const button = within(keep).getByRole("button", { name: "Keep it" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(within(keep).getByRole("textbox", { name: "Why keep it" }), { target: { value: "  The board asked for it.  " } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("value-kept").textContent).toBe("Kept: The board asked for it. · Ann"));
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/projects/p1/intake-drafts/REQ-9/keep", { reason: "The board asked for it." }]]);
    expect(screen.queryByTestId("value-keep")).toBeNull();
  });

  it("names the refusal core gives a keep, by its words", async () => {
    shown(draft({ value: value({ outcome: { kind: "refuse", reason: "No value." } }), can: { answer: true, keep: true } }), () => ({
      status: 409,
      // the envelope core's refused() answers with, cut to what a client reads
      body: {
        status: 409,
        code: "VALUE_CHECK_NOT_REFUSED",
        detail: "REQ-9 is draft: only a requirement its value check refused is kept",
        error: {
          code: "VALUE_CHECK_NOT_REFUSED",
          message: "refused, nothing written: VALUE_CHECK_NOT_REFUSED at /ref: REQ-9 is draft: only a requirement its value check refused is kept",
          refusals: [{ code: "VALUE_CHECK_NOT_REFUSED", path: "/ref", detail: "REQ-9 is draft: only a requirement its value check refused is kept" }],
        },
      },
    }));
    const keep = await screen.findByTestId("value-keep");
    fireEvent.change(within(keep).getByRole("textbox"), { target: { value: "Still wanted" } });
    fireEvent.click(within(keep).getByRole("button"));
    expect((await screen.findByTestId("value-keep-refusal")).textContent).toContain("only a requirement its value check refused is kept");
  });

  it("holds the check on a blocking question, answered by a chip, then says it checks again (BC-3, BC-4)", async () => {
    const blocking = question({ prompt: "Who reads the report?", blocks: "problem", options: [{ id: "clerks", label: "Clerks", effect: "Built for the desk" }, { id: "managers", label: "Managers", effect: "Built for the weekly review" }], recommended: "clerks" });
    const held = draft({ questions: [blocking], value: value({ who: null, outcome: null }) });
    const answered = draft({ questions: [{ ...blocking, answer: { option: "managers", label: "Managers", by: { id: "u1", name: "Ann" }, at: "2026-10-25T09:00:00.000Z" } }], value: value({ who: null, outcome: null }) });
    const { calls } = shown(held, () => ({ body: { draft: answered } }));
    expect((await screen.findByTestId("value-check")).dataset.outcome).toBe("held");
    expect(screen.getByTestId("value-who").textContent).toBe("Who it is forNot given");
    expect(screen.getByTestId("value-outcome").textContent).toBe("OutcomeHeld until the blocking question is answered");
    const q = screen.getByTestId("intake-question");
    expect(q.dataset.blocks).toBe("problem");
    expect(within(q).getByText("Blocks on who it serves")).toBeTruthy();
    expect(within(q).getByTestId("intake-question-state").textContent).toBe("Waiting on your answer · Built for the desk");
    fireEvent.click(within(q).getByRole("button", { name: /Managers/ }));
    await waitFor(() => expect(screen.getByTestId("value-outcome").textContent).toBe("OutcomeAnswered; checking again"));
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/projects/p1/intake-drafts/REQ-9/answers", { question: 1, option: "managers" }]]);
    expect(within(screen.getByTestId("intake-question")).getByTestId("intake-question-state").textContent).toBe("Answered by Ann · Built for the weekly review");
  });

  it("says a gap that does not block takes its recommended answer until it is answered (BC-5)", async () => {
    shown(draft());
    const q = await screen.findByTestId("intake-question");
    expect(q.dataset.blocks).toBeUndefined();
    expect(within(q).getByTestId("intake-question-state").textContent).toBe("Assumed until answered · One report a week");
    expect(within(q).getByRole("button", { name: /Weekly/ }).textContent).toBe("WeeklyRecommended");
  });

  it("shows the options without chips to a reader who may not answer, and the answers given before", async () => {
    shown(draft({ can: { answer: false, keep: false }, answered: [{ prompt: "Who reads it?", label: "Managers", by: { id: "u1", name: "Ann" }, at: "2026-10-25T09:00:00.000Z" }] }));
    const options = await screen.findAllByTestId("intake-option");
    expect(options.map((o) => [o.textContent, o.dataset.recommended ?? null])).toEqual([
      ["WeeklyRecommended", "true"],
      ["Monthly", null],
    ]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("intake-answered").textContent).toBe("Who reads it? → Managers · Ann");
  });

  it("says a draft made before the check was not checked, and shows nothing before a draft or on a failed one", async () => {
    shown(draft({ value: null, questions: [], nothingToAsk: "The record settles it." }));
    expect((await screen.findByTestId("value-check")).textContent).toContain("Drafted before the value check");
    expect(screen.getByTestId("intake-nothing-to-ask").textContent).toBe("Nothing · The record settles it.");
    vi.unstubAllGlobals();
    const none = shown(null);
    await waitFor(() => expect(none.calls).toHaveLength(1));
    expect(none.container.querySelector("[data-testid=value-check]")).toBeNull();
    vi.unstubAllGlobals();
    const failed = shown(draft({ outcome: "failed", code: "INTAKE_SHAPE", value: null }));
    await waitFor(() => expect(failed.calls).toHaveLength(1));
    expect(failed.container.querySelector("[data-testid=value-check]")).toBeNull();
  });
});
