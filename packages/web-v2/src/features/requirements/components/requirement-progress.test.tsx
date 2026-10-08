// REQ-35 BC-5, BC-6, BC-7, BC-13 (ISS-461): a requirement's state reads from its first screen. One
// strip at the top of the main column, on every width, says whom it waits on, the lifecycle step and
// the one after, and k/n verified; the criteria read as a checklist of verdict dots; revisions,
// decisions and activity stay folded until opened. The strip's steps are the lifecycle's own and its
// marks the verdicts' own, so no second step list or verdict vocabulary exists to drift.

import { BC_VERDICT_LABELS, REQUIREMENT_LIFECYCLE, REQUIREMENT_STATE_LABELS } from "@forge/contracts/requirements";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { RequirementPage } from "./requirement-detail";
import { RequirementPeek } from "./requirement-peek";
import { RequirementProgress } from "./standing-bits";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";

const decision = { id: "d1", target: { scope: "requirement", id: "t-d1", key: "REQ-1", title: null }, intent: "decision", body: null, format: "markdown", decision: { decision: "Keep the clinic name", reason: "asked" }, parentId: null, author: { id: "u1", name: "Dana", agency: "human" }, withheld: false, edited: false, createdAt: "2026-10-07T10:00:00Z", updatedAt: "2026-10-07T10:00:00Z", datedAhead: null };

function core() {
  return fakeCore((c: Call) => {
    if (c.path.startsWith(`/projects/${PROJECT}/requirements/REQ-1/decisions`)) return { body: { decisions: [decision], answers: [], by: "people", folded: 0 } };
    if (c.path.includes("/comments")) return { body: { comments: [], returned: 0 } };
    return HANG;
  });
}

const client = (d: RequirementDetail = reqDetail) => {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  c.setQueryData(["requirement", PROJECT, "REQ-1"], d);
  return c;
};

function page(tab: "overview" | "criteria" | "revisions" | "decisions" | "activity", d: RequirementDetail = reqDetail) {
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab={tab} onTab={() => {}} />, client(d));
}

/** The word of `root`'s strip or checklist that is not the lifecycle's or a verdict's own; null when every one is. */
function outsideVocabulary(root: HTMLElement): string | null {
  const steps = new Set<string>(REQUIREMENT_LIFECYCLE.map((s) => REQUIREMENT_STATE_LABELS[s]));
  const verdicts = new Set<string>(Object.values(BC_VERDICT_LABELS));
  for (const li of root.querySelectorAll('[data-testid="step-bar"] ol > li')) {
    const word = li.querySelector("span:not([aria-hidden])")?.textContent ?? "";
    if (!steps.has(word)) return `the step "${word}"`;
  }
  const marks = root.querySelector('[data-testid="progress-verified"] [role="img"]')?.getAttribute("aria-label")?.split(", ") ?? [];
  for (const m of marks) {
    const word = m.split(" · ")[1] ?? "";
    if (!verdicts.has(word)) return `the mark "${m}"`;
  }
  for (const dot of root.querySelectorAll('[data-testid="verdict-dot"]')) {
    const word = dot.getAttribute("aria-label") ?? "";
    if (!verdicts.has(word)) return `the dot "${word}"`;
  }
  return null;
}

const HIDES = /(^|\s)(hidden|(max-)?(sm|md|lg):hidden)(\s|$)/;

afterEach(() => vi.unstubAllGlobals());

describe("the top of a requirement page", () => {
  it("opens on one strip above the tabs: whom it waits on, the step it stands at and the next one, and k/n verified", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    expect(strip.compareDocumentPosition(screen.getByTestId("requirement-tabs")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(strip).getByTestId("wait-banner")).toHaveTextContent("Waiting on you: accept r2");
    expect(within(strip).getByTestId("step-bar")).toHaveTextContent("Step 2 of 5 · next In delivery");
    expect(within(strip).getByRole("listitem", { current: "step" })).toHaveTextContent("Agreed");
    // 1 of the 3 criteria core lists is passing (BC-1); BC-2 fails and BC-3 has no issue
    expect(within(strip).getByTestId("progress-verified")).toHaveTextContent("1/3 verified");
    expect(within(strip).getByRole("img", { name: "BC-1 · Passing, BC-2 · Failing, BC-3 · Gap" })).toBeInTheDocument();
  });

  it("stands on every width: nothing in or around it hides below or above a breakpoint", () => {
    core();
    page("overview");
    for (let el: HTMLElement | null = screen.getByTestId("requirement-progress"); el; el = el.parentElement) {
      expect(el.className, `<${el.tagName.toLowerCase()} data-testid="${el.dataset.testid ?? ""}">`).not.toMatch(HIDES);
    }
    for (const el of screen.getByTestId("requirement-progress").querySelectorAll("[class]")) expect(el.getAttribute("class")).not.toMatch(HIDES);
  });

  it("is the only progress view: the rail draws no step bar, whose-turn fact or coverage group, and no phone-only copy stands", () => {
    core();
    page("overview");
    const rail = screen.getByTestId("relations-rail");
    expect(within(rail).queryByTestId("step-bar")).toBeNull();
    expect(within(rail).queryByTestId("waiting-on")).toBeNull();
    expect(within(rail).queryByTestId("facts-coverage")).toBeNull();
    expect(screen.queryByTestId("phone-progress")).toBeNull();
    expect(screen.getAllByTestId("step-bar")).toHaveLength(1);
    expect(screen.getAllByTestId("wait-banner")).toHaveLength(1);
  });

  it("says nothing is owed on an accepted one, at the lifecycle's last step with no next", () => {
    const accepted = { ...reqDetail, standing: { ...reqDetail.standing, state: "accepted", attentionGroup: "done", waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.empty"), rule: RULE }) } } as RequirementDetail;
    render(<RequirementProgress standing={accepted.standing} inset="px-4" />);
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Accepted. Nothing is owed on it.");
    expect(screen.getByTestId("step-bar")).toHaveTextContent("Step 5 of 5");
    expect(screen.getByTestId("step-bar")).not.toHaveTextContent("next");
  });

  it("draws no step bar for one off the lifecycle, rather than a step of its own", () => {
    const deferred = { ...reqDetail.standing, state: "deferred" } as RequirementDetail["standing"];
    render(<RequirementProgress standing={deferred} inset="px-4" />);
    expect(screen.queryByTestId("step-bar")).toBeNull();
    expect(screen.getByTestId("progress-verified")).toHaveTextContent("1/3 verified");
  });

  it("is the peek's top too, in place of the banner it carried alone", () => {
    core();
    renderWithQuery(<RequirementPeek projectId={PROJECT} slug="hop" reqKey="REQ-1" peek={{ open: "REQ-1", position: { at: 1, of: 1 }, set: () => {}, move: () => {} }} onOpenFull={() => {}} />, client());
    const strip = screen.getByTestId("requirement-progress");
    expect(within(strip).getByTestId("step-bar")).toBeInTheDocument();
    expect(screen.getAllByTestId("wait-banner")).toHaveLength(1);
    expect(within(screen.getByTestId("requirement-facts")).queryByTestId("step-bar")).toBeNull();
  });
});

describe("the criteria", () => {
  it("read as a checklist headed k/n verified, a verdict dot leading each criterion", () => {
    core();
    page("criteria");
    expect(screen.getByTestId("criteria-verified")).toHaveTextContent("1/3 verified");
    const rows = within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-row");
    expect(rows.map((r) => [r.firstElementChild?.getAttribute("data-testid"), within(r).getByTestId("verdict-dot").getAttribute("aria-label")])).toEqual([
      ["verdict-dot", "Passing"],
      ["verdict-dot", "Failing"],
      ["verdict-dot", "Gap"],
    ]);
  });
});

describe("the strip's and the checklist's words", () => {
  it("are the lifecycle's steps and the verdicts' own words, and nothing else", () => {
    core();
    page("criteria");
    expect(outsideVocabulary(document.body)).toBeNull();
    const steps = [...screen.getByTestId("step-bar").querySelectorAll("ol > li")].map((li) => li.querySelector("span:not([aria-hidden])")?.textContent);
    expect(steps).toEqual(REQUIREMENT_LIFECYCLE.map((s) => REQUIREMENT_STATE_LABELS[s]));
  });

  it("goes red, naming the word, on a step, a mark or a dot planted outside the vocabulary", () => {
    const planted = (html: string) => {
      const root = document.createElement("div");
      root.innerHTML = html;
      return outsideVocabulary(root);
    };
    expect(planted('<div data-testid="step-bar"><ol><li><span aria-hidden="true"></span><span>In review</span></li></ol></div>')).toBe('the step "In review"');
    expect(planted('<div data-testid="progress-verified"><span role="img" aria-label="BC-1 · Verified"></span></div>')).toBe('the mark "BC-1 · Verified"');
    expect(planted('<span data-testid="verdict-dot" aria-label="Done"></span>')).toBe('the dot "Done"');
    expect(planted('<span data-testid="verdict-dot" aria-label="Passing"></span>')).toBeNull();
  });
});

describe("revisions, decisions and activity", () => {
  it("fold a proposal's diff and the revision list until opened", async () => {
    core();
    page("revisions");
    expect(screen.getByTestId("open-revision")).toHaveTextContent("Thay doi 2");
    expect(screen.queryByTestId("revision-diff")).toBeNull();
    expect(screen.queryByTestId("revision-list")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Changes against r1/ }));
    expect(screen.getByTestId("revision-diff")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /All revisions/ }));
    expect(within(screen.getByTestId("revision-list")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("fold the decisions and the answers, and leave the composer open", async () => {
    core();
    page("decisions");
    const open = await screen.findByRole("button", { name: /Decisions/ });
    expect(screen.queryByTestId("decision-row")).toBeNull();
    expect(screen.getByTestId("decision-composer")).toBeInTheDocument();
    expect(open).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(open);
    expect(screen.getByTestId("decision-row")).toHaveTextContent("Keep the clinic name");
  });

  it("fold the comments and the history, reading the thread only once opened", async () => {
    const calls = core();
    page("activity");
    expect(screen.queryByTestId("entity-comment-thread")).toBeNull();
    expect(screen.queryByTestId("requirement-history")).toBeNull();
    expect(calls.some((c) => c.path.includes("/comments"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(screen.getByTestId("requirement-history")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Comments/ }));
    expect(screen.getByTestId("entity-comment-thread")).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/comments"))).toBe(true);
  });
});
