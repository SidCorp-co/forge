// REQ-35 BC-5, BC-6, BC-13 (ISS-461 round 3): the strip names whom the requirement actually waits on,
// as core's standing says it, and links what that wait is about; a lifecycle step name stands only in
// the one step bar, however it is marked up; nothing outside the strip, on any tab or in the peek,
// says a second waiting-on or verified count; nothing around the strip collapses or clips it at phone
// width (layout itself is proven in headless Chrome, where it exists); issue keys keep to one line.

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { WaitingOn } from "@/design";
import { core, hidingOf, page, peek, secondProgress, strayInStrip } from "@/test/requirement-progress";
import { RULE, say, waitingOn } from "@/test/said";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { VerdictDot } from "./standing-bits";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

describe("whom the strip names once the work has landed or parked", () => {
  const DANA = say("standing.who.named", { name: "Dana Lee" });
  const cut = { ...waitingOn("person", { who: DANA, act: say("standing.act.cutThenApprove", { v: "0.1.0" }), rule: RULE }), ref: "0.1.0", refers: "release" as const };
  const parkedOn = {
    ...waitingOn("person", { who: say("standing.who.named", { name: "Chuong Le" }), act: say("standing.act.onIssue", { act: say("issues.standing.act.decide"), key: "ISS-458" }), rule: RULE }),
    ref: "ISS-458",
    refers: "issue" as const,
  };
  const withWait = (w: RequirementDetail["standing"]["waitingOn"]) => ({ ...reqDetail, standing: { ...reqDetail.standing, state: "in_delivery", attentionGroup: "moving", waitingOn: w } }) as RequirementDetail;

  it("names the person owing the release cut and links the release, on the page and in the peek", () => {
    core();
    page("overview", withWait(cut));
    const strip = screen.getByTestId("requirement-progress");
    expect(within(strip).getByTestId("wait-banner")).toHaveTextContent("Waiting on Dana Lee: cut 0.1.0, then approve it");
    expect(within(strip).getByRole("link", { name: "0.1.0" })).toHaveAttribute("href", "/projects/hop/releases/0.1.0");
    expect(strayInStrip(strip, withWait(cut).standing)).toBeNull();
    expect(secondProgress(document.body, withWait(cut).standing)).toBeNull();
  });

  it("names what a parked issue waits on and links the issue", () => {
    core();
    page("overview", withWait(parkedOn));
    const strip = screen.getByTestId("requirement-progress");
    expect(within(strip).getByTestId("wait-banner")).toHaveTextContent("Waiting on Chuong Le: make a decision on ISS-458");
    expect(within(strip).getByRole("link", { name: "ISS-458" })).toHaveAttribute("href", "/projects/hop/issues/ISS-458");
    expect(strayInStrip(strip, withWait(parkedOn).standing)).toBeNull();
  });

  it("goes red when the wait's issue or release is left unlinked or another link is planted", () => {
    core();
    page("overview", withWait(cut));
    const strip = screen.getByTestId("requirement-progress");
    const link = within(strip).getByRole("link", { name: "0.1.0" });
    // the act linked nothing: what a person meets on REQ-35 before this round
    expect(within(strip).queryAllByTestId("wait-ref").filter((a) => a.getAttribute("href")?.endsWith("/releases/0.1.0"))).toHaveLength(1);
    link.removeAttribute("data-refers");
    expect(strayInStrip(strip, withWait(cut).standing)).toBe('a link of the banner\'s own: "0.1.0"');
    link.setAttribute("data-refers", "release");
    const other = document.createElement("a");
    other.textContent = "releases";
    within(strip).getByTestId("wait-banner").appendChild(other);
    expect(strayInStrip(strip, withWait(cut).standing)).toMatch(/in the banner$/);
    other.remove();
    expect(strayInStrip(strip, withWait(cut).standing)).toBeNull();
  });
});

describe("a lifecycle step outside the step bar", () => {
  it("goes red however it is marked up: spans, one sentence, a tooltip or an accessible name", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    const plant = (html: string) => {
      const el = document.createElement("div");
      el.innerHTML = html;
      strip.appendChild(el);
      const why = strayInStrip(strip, reqDetail.standing);
      el.remove();
      return why;
    };
    // the judge's round-2 plant 02b, which stayed green
    expect(plant('<div class="flex"><span>Draft</span><span>Agreed</span><span>Accepted</span></div>')).toBe('a lifecycle step outside the step bar: "Draft"');
    expect(plant("<p>Draft → Agreed → Accepted</p>")).toBe('a lifecycle step outside the step bar: "Draft → Agreed → Accepted"');
    expect(plant("<b>in delivery</b>")).toBe('a lifecycle step outside the step bar: "in delivery"');
    expect(plant('<span title="Agreed, then In delivery"></span>')).toBe('a lifecycle step outside the step bar, in its title "Agreed, then In delivery"');
    expect(plant('<span aria-label="Step: Delivered"></span>')).toBe('a lifecycle step outside the step bar, in its aria-label "Step: Delivered"');
    expect(plant('<div role="list"><div role="listitem">Agreed</div></div>')).toMatch(/^a list of its own/);
    expect(strayInStrip(strip, reqDetail.standing)).toBeNull();
  });

  it("goes red on a step bar that is not the lifecycle, or carries a word of its own", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    const bar = within(strip).getByTestId("step-bar");
    const extra = document.createElement("span");
    extra.textContent = "Review";
    bar.appendChild(extra);
    expect(strayInStrip(strip, reqDetail.standing)).toBe('the text "Review" in the step bar');
    extra.remove();
    const last = bar.querySelector("ol")?.lastElementChild as Element;
    last.remove();
    expect(strayInStrip(strip, reqDetail.standing)).toBe('a step list that is not the lifecycle: "Draft, Agreed, In delivery, Delivered"');
  });
});

describe("one waiting-on and one verified count on the whole page", () => {
  const TABS = ["overview", "criteria", "revisions", "decisions", "activity", "mockups", "memory"] as const;

  it.each(TABS)("holds on the %s tab: nothing outside the strip says whom it waits on or how much is verified", (tab) => {
    core();
    page(tab as Parameters<typeof page>[0]);
    expect(secondProgress(document.body, reqDetail.standing)).toBeNull();
  });

  it("holds in the peek", () => {
    core();
    peek();
    expect(secondProgress(document.body, reqDetail.standing)).toBeNull();
  });

  /** Renders `node` into the element `testId` names, reads the page, and takes it out again. */
  const plantInto = (testId: string, node: ReactElement) => {
    const host = document.createElement("div");
    screen.getByTestId(testId).appendChild(host);
    const r = render(node, { container: host });
    const why = secondProgress(document.body, reqDetail.standing);
    r.unmount();
    host.remove();
    return why;
  };

  it("goes red on the design system's WaitingOn in the Overview tab and in the peek (judge round 2, plants 07a and 07b)", () => {
    core();
    page("overview");
    expect(plantInto("view-overview", <p>Owed next: <WaitingOn w={reqDetail.standing.waitingOn} /></p>)).toMatch(/^a second waiting-on: ".*You · accept r2"$/);
    expect(plantInto("view-overview", <WaitingOn w={reqDetail.standing.waitingOn} />)).toMatch(/^a second waiting-on: ".*You · accept r2"$/);
    cleanup();
    core();
    peek();
    expect(plantInto("requirement-facts", <WaitingOn w={reqDetail.standing.waitingOn} />)).toMatch(/^a second waiting-on: ".*You · accept r2"$/);
  });

  it("goes red on a second count or waiting-on in words, on any tab and in the rail", () => {
    core();
    page("activity");
    expect(plantInto("relations-rail", <span>Passing 1 of 3</span>)).toBe('a second verified count: "Passing 1 of 3"');
    expect(plantInto("relations-rail", <span>1/3 verified</span>)).toBe('a second verified count: "1/3 verified"');
    expect(plantInto("requirement-tabs", <span>3 of 5 criteria proven</span>)).toMatch(/^a second verified count: "\d*3 of 5 criteria/);
    expect(plantInto("relations-rail", <span>Owed next: accept r2</span>)).toBe('a second waiting-on: "Owed next"');
    expect(plantInto("relations-rail", <span>accept r2</span>)).toBe('a second waiting-on: "accept r2"');
    expect(plantInto("relations-rail", <VerdictDot verdict="passing" />)).toBe('a second verdict-dot: "✓"');
    expect(secondProgress(document.body, reqDetail.standing)).toBeNull();
  });
});

describe("the strip at phone width, around it", () => {
  it("goes red on every way an element around it can collapse, clip or push it away at phone width", () => {
    core();
    page("overview");
    const strip = screen.getByTestId("requirement-progress");
    const wrap = (cls: string, style?: string) => {
      const box = document.createElement("div");
      box.className = cls;
      if (style) box.setAttribute("style", style);
      strip.parentElement?.insertBefore(box, strip);
      box.appendChild(strip);
      const why = hidingOf(strip);
      box.parentElement?.insertBefore(strip, box);
      box.remove();
      return why;
    };
    // the judge's round-2 plant 09, which stayed green
    expect(wrap("overflow-hidden max-sm:h-[0px]")).toMatch(/around it: the class "max-sm:h-\[0px\]", a size no strip fits in/);
    for (const cls of ["h-[0px]", "max-sm:max-h-[0.1rem]", "max-sm:size-[2px]", "overflow-hidden max-sm:max-h-6", "max-h-10 overflow-clip", "max-sm:-mt-[2000px]", "max-sm:grid-rows-[0fr]", "max-sm:absolute", "max-sm:fixed", "max-md:[transform:scale(0)]", "max-sm:opacity-0", "max-sm:hidden"]) {
      expect(wrap(cls), cls).toMatch(/around it/);
    }
    for (const style of ["height: 0px", "max-height: 1px; overflow: hidden", "transform: scale(0)", "margin-top: -2000px", "position: absolute; left: -9999px", "opacity: 0"]) {
      expect(wrap("", style), style).toMatch(/around it/);
    }
    // space and layout may change at phone width, and a desktop-only scroll container does not touch a phone
    for (const cls of ["max-sm:px-4", "max-md:grid-cols-1", "lg:h-[calc(100dvh-48px)] overflow-y-auto", "min-w-0"]) {
      expect(wrap(cls), cls).toBeNull();
    }
    expect(hidingOf(strip)).toBeNull();
  });
});

describe("the criteria checklist at phone width", () => {
  it("keeps each issue key on one line", () => {
    core();
    const traced = { ...reqDetail, standing: { ...reqDetail.standing, coverage: reqDetail.standing.coverage } } as RequirementDetail;
    page("criteria", traced);
    const keys = within(screen.getByTestId("criteria-checklist")).getAllByTestId("criterion-issue-key");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.className.split(/\s+/), k.textContent ?? "").toContain("whitespace-nowrap");
      expect(k.className.split(/\s+/)).not.toContain("truncate");
    }
  });
});
