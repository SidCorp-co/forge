// REQ-35 BC-5, BC-6, BC-7, BC-13 (ISS-461): a requirement's state reads from its first screen. One
// strip at the top of the main column, on every width, says whom it waits on, where it stands on the
// lifecycle and the step after, and k/n verified; the criteria read as a checklist whose every verdict
// is a glyph dot named on it, never a colour alone; revisions, decisions and activity stay folded until
// opened. The strip's steps are the lifecycle's own, and the page reads one waiting-on, the strip's, so
// nothing else on it can disagree. REQ-43 BC-5, BC-8, BC-10 (ISS-496 part C): the header's badge says
// the state, so the bar names no step and an ended one's banner says only that nothing is owed; the
// counts per verdict live in the criteria's filter pills; past revisions and decisions sit in Activity.


import { BC_VERDICT_LABELS, type BcVerdict } from "@forge/contracts/requirements";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { core, hidingOf, mixed, page, peek, railRepeats, STEP_WORDS, strayInStrip } from "@/test/requirement-progress";
import { RULE, say, waitingOn } from "@/test/said";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { RequirementProgress } from "./standing-bits";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

describe("the top of a requirement page", () => {
  it("opens on one strip above the tabs: whom it waits on, the step it stands at and the next one, and k/n verified", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    expect(strip.compareDocumentPosition(screen.getByTestId("requirement-tabs")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(strip).getByTestId("wait-banner")).toHaveTextContent("Waiting on you: accept r2");
    // the header's badge says Agreed: the bar draws its place and names it only on its segment
    expect(within(strip).getByTestId("step-bar")).toHaveTextContent(/^Next: In delivery$/);
    expect(within(strip).getByRole("listitem", { current: "step" })).toHaveAccessibleName("Agreed");
    // 1 of the 3 criteria core lists is passing (BC-1); BC-2 fails and BC-3 has no issue
    expect(within(strip).getByTestId("progress-verified")).toHaveTextContent(/^1\/3 verified$/);
    expect(within(strip).queryByTestId("progress-verdicts")).toBeNull();
  });

  it("stands on every width: nothing in, on or around it hides at a breakpoint", () => {
    core();
    page("overview");
    expect(hidingOf(screen.getByTestId("requirement-progress"))).toBeNull();
  });

  it("goes red, naming it, on each way a strip can be hidden at phone width", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    const base = strip.className;
    const plant = (apply: (el: HTMLElement) => void, on: HTMLElement = strip) => {
      const before = { cls: on.className, style: on.getAttribute("style"), hidden: on.hidden };
      apply(on);
      const why = hidingOf(strip);
      on.className = before.cls;
      if (before.style === null) on.removeAttribute("style");
      else on.setAttribute("style", before.style);
      on.hidden = before.hidden;
      return why;
    };
    for (const cls of ["max-sm:hidden", "max-sm:sr-only", "max-md:invisible", "max-sm:opacity-0", "max-sm:h-0", "max-sm:size-0", "max-sm:-left-[9999px]", "max-sm:[display:none]", "sm:hidden", "hidden md:block", "max-sm:absolute"]) {
      expect(plant((el) => (el.className = `${base} ${cls}`)), cls).toMatch(/the class/);
    }
    expect(plant((el) => (el.hidden = true))).toMatch(/hidden attribute/);
    expect(plant((el) => (el.style.display = "none"))).toMatch(/the style/);
    expect(plant((el) => (el.className = `${el.className} max-sm:sr-only`), strip.parentElement as HTMLElement)).toMatch(/around it/);
    const inner = within(strip).getByTestId("progress-verified");
    expect(plant((el) => (el.className = `${el.className} max-sm:hidden`), inner)).toMatch(/progress-verified/);
    expect(hidingOf(strip)).toBeNull();
  });

  it("is the only progress view: the rail repeats no step, waiting-on, state or verified count, and no phone-only copy stands", () => {
    core();
    page("overview");
    expect(railRepeats(screen.getByTestId("relations-rail"))).toBeNull();
    expect(screen.queryByTestId("phone-progress")).toBeNull();
    expect(screen.getAllByTestId("step-bar")).toHaveLength(1);
    expect(screen.getAllByTestId("wait-banner")).toHaveLength(1);
  });

  it("goes red, naming it, on a step caption, a verified count, a criteria count, a waiting-on or the state planted in the rail", () => {
    core();
    page("overview");
    const rail = screen.getByTestId("relations-rail");
    const plant = (html: string) => {
      const el = document.createElement("p");
      el.innerHTML = html;
      rail.appendChild(el);
      const why = railRepeats(rail);
      el.remove();
      return why;
    };
    expect(plant("Step 2 of 5")).toMatch(/^a step caption/);
    expect(plant("1/3 verified")).toMatch(/^a verified count/);
    expect(plant("1 of 3 criteria proven · rest paused")).toMatch(/^a verified count/);
    // the rail's wording before this issue (judge round 2, plant 04c)
    expect(plant("Coverage Passing 1 of 3")).toBe('a verified count: "Passing 1 of 3"');
    expect(plant("Paused — waiting on Odin Forecast to cut 0.1.0")).toMatch(/^a waiting-on/);
    expect(plant('<span data-testid="status-badge" data-family="requirement">Agreed</span>')).toMatch(/state badge/);
    expect(plant('<span data-testid="status-badge" data-family="issue">Draft</span>')).toBeNull();
    expect(railRepeats(rail)).toBeNull();
  });

  it("reads one waiting-on on the whole page, the strip's: a forecast paused on someone else is said nowhere", () => {
    core();
    page("overview");
    // how many issues shipped is the strip's wait and each row's status: the rail counts none (REQ-43 BC-5)
    expect(within(screen.getByTestId("facts-issues")).queryByText(/shipped ·/)).toBeNull();
    const strip = screen.getByTestId("requirement-progress");
    const outside = document.body.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="requirement-progress"]')?.remove();
    expect(outside.textContent).not.toMatch(/Odin Forecast/);
    expect(outside.textContent).not.toMatch(/waiting on|waits on|paused/i);
    expect(within(strip).getAllByText(/Waiting on/)).toHaveLength(1);
  });

  it("says nothing is owed on an accepted one, at the lifecycle's last step with no next", () => {
    const accepted = { ...reqDetail, standing: { ...reqDetail.standing, state: "accepted", next: null, attentionGroup: "done", waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.empty"), rule: RULE }) } } as RequirementDetail;
    render(<RequirementProgress standing={accepted.standing} slug="hop" inset="px-4" />);
    expect(screen.getByTestId("wait-banner")).toHaveTextContent(/^Nothing owed$/);
    expect(screen.getByTestId("step-bar")).toHaveTextContent(/^$/);
    expect(screen.getAllByRole("listitem").at(-1)).toHaveAccessibleName("Accepted");
    expect(strayInStrip(screen.getByTestId("requirement-progress"), accepted.standing)).toBeNull();
  });

  it("draws no step bar for one off the lifecycle, and says the step core says it goes back to (REQ-34 BC-19)", () => {
    const deferred = { ...reqDetail.standing, state: "deferred", next: "agreed" } as RequirementDetail["standing"];
    render(<RequirementProgress standing={deferred} slug="hop" inset="px-4" />);
    expect(screen.queryByTestId("step-bar")).toBeNull();
    expect(screen.getByTestId("step-off-line")).toHaveTextContent(/^Next: Agreed$/);
    expect(screen.getByTestId("progress-verified")).toHaveTextContent("1/3 verified");
  });

  it("is the peek's top too, in place of the banner it carried alone, over a rail that repeats none of it", () => {
    core();
    peek();
    const strip = screen.getByTestId("requirement-progress");
    expect(within(strip).getByTestId("step-bar")).toBeInTheDocument();
    expect(screen.getAllByTestId("wait-banner")).toHaveLength(1);
    expect(railRepeats(screen.getByTestId("requirement-facts"))).toBeNull();
  });
});

describe("the verified count", () => {
  it("counts passing criteria only: stale, not judged, failing and gap are not verified", () => {
    core();
    page("criteria", mixed);
    expect(within(screen.getByTestId("requirement-progress")).getByTestId("progress-verified")).toHaveTextContent(/^1\/5 verified$/);
    // said once: the criteria view does not count it again (REQ-43 BC-5)
    expect(screen.getAllByText(/verified/)).toHaveLength(1);
  });
});

describe("the criteria", () => {
  it("read as a checklist under verdict pills, a glyph dot leading each criterion", () => {
    core();
    page("criteria");
    expect(screen.getByTestId("criteria-filter")).toBeInTheDocument();
    const rows = within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-row");
    expect(rows.map((r) => [r.querySelector('[data-testid="verdict-dot"]') === r.firstElementChild?.firstElementChild, within(r).getByTestId("verdict-dot").textContent])).toEqual([
      [true, "✓"],
      [true, "×"],
      [true, "!"],
    ]);
  });

  it("mark each verdict with its own glyph named on it, never by colour alone, and count them only in the pills (REQ-43 BC-10)", async () => {
    core();
    page("criteria", mixed);
    const rows = within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-row");
    for (const r of rows) {
      const dot = within(r).getByTestId("verdict-dot");
      expect(dot).toHaveAccessibleName(BC_VERDICT_LABELS[r.getAttribute("data-verdict") as BcVerdict]);
      // the mark is the row's one verdict: no row says its verdict's word
      expect(r.textContent).not.toContain(BC_VERDICT_LABELS[r.getAttribute("data-verdict") as BcVerdict]);
    }
    // every dot draws its own glyph, so two verdicts of one colour never look alike
    expect(new Set(rows.map((r) => within(r).getByTestId("verdict-dot").textContent)).size).toBe(5);
    const pills = within(screen.getByTestId("criteria-filter")).getAllByRole("button");
    expect(pills.map((b) => b.textContent)).toEqual(["All5", "Passing1", "Failing1", "Stale1", "Not judged1", "Gap1"]);
    await userEvent.click(within(screen.getByTestId("criteria-filter")).getByTestId("criteria-filter-failing"));
    expect(within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-row").map((r) => r.getAttribute("data-verdict"))).toEqual(["failing"]);
  });
});

describe("the strip's words", () => {
  it("are the lifecycle's steps and the verdicts' own words, and nothing else", () => {
    core();
    page("criteria", mixed);
    const strip = screen.getByTestId("requirement-progress");
    expect(strayInStrip(strip, mixed.standing)).toBeNull();
    const steps = [...within(strip).getByTestId("step-bar").querySelectorAll("ol > li")].map((li) => li.getAttribute("aria-label"));
    expect(steps).toEqual(STEP_WORDS);
  });

  it("go red, naming it, on a second step list, a list of the lifecycle's words, a word of their own or a count that is not the standing's", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    const plant = (html: string, into: Element = strip) => {
      const el = document.createElement("div");
      el.innerHTML = html;
      into.appendChild(el);
      const why = strayInStrip(strip, reqDetail.standing);
      el.remove();
      return why;
    };
    expect(plant("<ol><li>Draft</li><li>Review</li><li>Build</li><li>Live</li></ol>")).toMatch(/^a list of its own/);
    expect(plant(`<ul>${STEP_WORDS.map((w) => `<li>${w}</li>`).join("")}</ul>`)).toMatch(/^a list of its own/);
    expect(plant('<div data-testid="step-bar"><ol><li><span>Draft</span></li></ol></div>')).toMatch(/^a second step list/);
    expect(plant("<span>3 broken · 2 untested</span>")).toBe('the text "3 broken · 2 untested"');
    expect(plant("<span>2/3 verified</span>")).toBe('the text "2/3 verified"');
    expect(plant('<ul data-testid="progress-verdicts"><li data-verdict="passing">1 Passing</li></ul>')).toMatch(/^a list of its own/);
    expect(plant("<span>Verified</span>", within(strip).getByTestId("wait-banner"))).toBe('the text "Waiting on you: accept r2Verified" in the banner');
    expect(strayInStrip(strip, reqDetail.standing)).toBeNull();
  });
});

// ISS-461 round 3, REQ-35 BC-5: the strip names whom the requirement actually waits on, as core's
// standing says it (`requirements/standing-work.ts`), and links what that wait is about.
describe("revisions, decisions and activity", () => {
  it("fold a proposal's diff until opened, and keep the revisions that stood for Activity (REQ-43 BC-8)", async () => {
    core();
    page("revisions");
    expect(screen.getByTestId("open-revision")).toHaveTextContent("Thay doi 2");
    expect(screen.queryByTestId("revision-diff")).toBeNull();
    expect(screen.queryByRole("button", { name: /All revisions/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Changes against r1/ }));
    expect(screen.getByTestId("revision-diff")).toBeInTheDocument();
  });

  it("fold every revision under Activity until opened", async () => {
    core();
    page("activity");
    expect(screen.queryByTestId("revision-list")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /All revisions/ }));
    expect(within(screen.getByTestId("revision-list")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("fold the decisions and the answers under Activity, and leave the composer open", async () => {
    core();
    page("activity");
    const open = await screen.findByRole("button", { name: /Decisions/ });
    expect(screen.queryByTestId("decision-row")).toBeNull();
    expect(screen.queryByTestId("requirement-answer")).toBeNull();
    expect(screen.getByRole("button", { name: /Answers/ })).toHaveAttribute("aria-expanded", "false");
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
