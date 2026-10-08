// REQ-35 BC-5, BC-6, BC-7, BC-13 (ISS-461): a requirement's state reads from its first screen. One
// strip at the top of the main column, on every width, says whom it waits on, the lifecycle step and
// the one after, and k/n verified over a count per verdict; the criteria read as a checklist whose
// every verdict is a glyph dot beside its word, never a colour alone; revisions, decisions and activity
// stay folded until opened. The strip's steps are the lifecycle's own and its words the verdicts' own,
// and the page reads one waiting-on, the strip's, so nothing else on it can disagree.


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
    expect(within(strip).getByTestId("step-bar")).toHaveTextContent("Step 2 of 5 · next In delivery");
    expect(within(strip).getByRole("listitem", { current: "step" })).toHaveTextContent("Agreed");
    // 1 of the 3 criteria core lists is passing (BC-1); BC-2 fails and BC-3 has no issue
    expect(within(strip).getByTestId("progress-verified")).toHaveTextContent("1/3 verified");
    expect([...within(strip).getByTestId("progress-verdicts").children].map((li) => li.textContent)).toEqual(["✓1Passing", "×1Failing", "!1Gap"]);
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

  it("reads one waiting-on on the whole page, the strip's: a forecast paused on someone else is said nowhere", async () => {
    const calls = core();
    page("overview");
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/forecast/requirements/REQ-1"))).toBe(true));
    // the forecast's own progress count has arrived, so everything the rail reads from it is drawn
    expect(await within(screen.getByTestId("facts-issues")).findByText("1 shipped · 0 landed, awaiting release · 1 to do")).toBeInTheDocument();
    const strip = screen.getByTestId("requirement-progress");
    const outside = document.body.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="requirement-progress"]')?.remove();
    expect(outside.textContent).not.toMatch(/Odin Forecast/);
    expect(outside.textContent).not.toMatch(/waiting on|waits on|paused/i);
    expect(within(strip).getAllByText(/Waiting on/)).toHaveLength(1);
  });

  it("says nothing is owed on an accepted one, at the lifecycle's last step with no next", () => {
    const accepted = { ...reqDetail, standing: { ...reqDetail.standing, state: "accepted", attentionGroup: "done", waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.empty"), rule: RULE }) } } as RequirementDetail;
    render(<RequirementProgress standing={accepted.standing} slug="hop" inset="px-4" />);
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Accepted. Nothing is owed on it.");
    expect(screen.getByTestId("step-bar")).toHaveTextContent("Step 5 of 5");
    expect(screen.getByTestId("step-bar")).not.toHaveTextContent("next");
    expect(strayInStrip(screen.getByTestId("requirement-progress"), accepted.standing)).toBeNull();
  });

  it("draws no step bar for one off the lifecycle, rather than a step of its own", () => {
    const deferred = { ...reqDetail.standing, state: "deferred" } as RequirementDetail["standing"];
    render(<RequirementProgress standing={deferred} slug="hop" inset="px-4" />);
    expect(screen.queryByTestId("step-bar")).toBeNull();
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
    expect(within(screen.getByTestId("requirement-progress")).getByTestId("progress-verified")).toHaveTextContent(/^1\/5 verified/);
    expect(screen.getByTestId("criteria-verified")).toHaveTextContent(/^1\/5 verified$/);
    expect([...screen.getByTestId("progress-verdicts").children].map((li) => li.getAttribute("data-verdict"))).toEqual(["passing", "failing", "stale", "not_judged", "gap"]);
  });
});

describe("the criteria", () => {
  it("read as a checklist headed k/n verified, a glyph dot leading each criterion", () => {
    core();
    page("criteria");
    expect(screen.getByTestId("criteria-verified")).toHaveTextContent("1/3 verified");
    const rows = within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-row");
    expect(rows.map((r) => [r.querySelector('[data-testid="verdict-dot"]') === r.firstElementChild?.firstElementChild, within(r).getByTestId("verdict-dot").textContent])).toEqual([
      [true, "✓"],
      [true, "×"],
      [true, "!"],
    ]);
  });

  it("say each verdict in a word a sighted reader sees on a phone, never by colour alone", () => {
    core();
    page("criteria", mixed);
    const rows = within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-row");
    expect(rows.map((r) => within(r).getByTestId("verdict-word").textContent)).toEqual(["Passing", "Failing", "Stale", "Not judged", "Gap"]);
    for (const r of rows) {
      const word = within(r).getByTestId("verdict-word");
      // the word is text, not a label only a screen reader or a hover reads
      expect(word.closest("[aria-hidden]")).toBeNull();
      expect(hidingOf(word)).toBeNull();
      expect(BC_VERDICT_LABELS[r.getAttribute("data-verdict") as BcVerdict]).toBe(word.textContent);
    }
    // every dot draws its own glyph, so two verdicts of one colour never look alike
    expect(new Set(rows.map((r) => within(r).getByTestId("verdict-dot").textContent)).size).toBe(5);
    for (const li of screen.getByTestId("progress-verdicts").children) {
      expect(within(li as HTMLElement).getByTestId("verdict-word").textContent).toBe(BC_VERDICT_LABELS[li.getAttribute("data-verdict") as BcVerdict]);
      expect(hidingOf(li as HTMLElement)).toBeNull();
    }
  });
});

describe("the strip's words", () => {
  it("are the lifecycle's steps and the verdicts' own words, and nothing else", () => {
    core();
    page("criteria", mixed);
    const strip = screen.getByTestId("requirement-progress");
    expect(strayInStrip(strip, mixed.standing)).toBeNull();
    const steps = [...within(strip).getByTestId("step-bar").querySelectorAll("ol > li")].map((li) => li.querySelector("span:not([aria-hidden])")?.textContent);
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
    expect(plant('<li data-verdict="passing"><span data-testid="verdict-word">Done</span></li>', within(strip).getByTestId("progress-verdicts"))).toMatch(/^a verdict count/);
    expect(plant("<span>Verified</span>", within(strip).getByTestId("wait-banner"))).toBe('the text "Waiting on you: accept r2Verified" in the banner');
    expect(strayInStrip(strip, reqDetail.standing)).toBeNull();
  });
});

// ISS-461 round 3, REQ-35 BC-5: the strip names whom the requirement actually waits on, as core's
// standing says it (`requirements/standing-work.ts`), and links what that wait is about.
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
