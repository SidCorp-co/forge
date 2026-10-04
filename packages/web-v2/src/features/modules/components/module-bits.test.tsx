// @vitest-environment jsdom
//
// The small marks a module is read by: its attention badge, the open-by-state bar on one scale, the
// "Not available" that carries its reason, and the banner that says whom it waits on without
// repeating the one act the header already offers.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standing, needsYou } from "./module-fixtures";
import { NotAvailable } from "@/design";
import { AttentionBadge, ModuleAction, ModuleBanner, moduleWaitingView, OpenBar } from "./module-bits";

expect.extend(matchers);
afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("AttentionBadge", () => {
  it("reads sentence case, with the raw value and its meaning only on hover", () => {
    render(<AttentionBadge group="needs_you" />);
    const b = screen.getByTestId("status-badge");
    expect(b.textContent).toBe("Needs you");
    expect(b.getAttribute("title")).toMatch(/^needs_you · /);
    expect(b.dataset.tone).toBe("you");
  });
});

describe("OpenBar", () => {
  it("draws each state present as a share of the project's largest module", () => {
    render(<OpenBar standing={needsYou} max={6} />);
    const bar = screen.getByRole("img", { name: /Needs you 1/ });
    expect(bar.getAttribute("aria-label")).toBe("Needs you 1 · Moving 1 · Queued 1");
    const widths = [...bar.children].map((c) => (c as HTMLElement).style.width);
    expect(widths).toEqual(["16.666666666666664%", "16.666666666666664%", "16.666666666666664%"]);
  });

  it("says nothing is open instead of drawing an empty scale", () => {
    render(<OpenBar standing={standing()} max={6} />);
    expect(screen.getByRole("img", { name: "Nothing open" })).toBeInTheDocument();
  });

  it("names the last landing on the recency dot, or says none has landed", () => {
    const { unmount } = render(<OpenBar standing={needsYou} max={3} />);
    expect(screen.getByTestId("recency-dot").getAttribute("title")).toMatch(/^Last landing ISS-2 · /);
    unmount();
    render(<OpenBar standing={standing()} max={3} />);
    expect(screen.getByTestId("recency-dot").getAttribute("title")).toBe("Nothing has landed in this module yet");
  });
});

describe("NotAvailable", () => {
  it("says it is not available and keeps the reason for hover, capitalised", () => {
    render(<NotAvailable reason="a module label records no owner" />);
    const n = screen.getByTestId("not-available");
    expect(n.textContent).toBe("Not available");
    expect(n.getAttribute("title")).toBe("A module label records no owner");
  });

  it("can print the reason beside it where the view has room", () => {
    render(<NotAvailable reason="no knowledge entry is linked to this module" showReason />);
    expect(screen.getByTestId("not-available").textContent).toBe("Not available: no knowledge entry is linked to this module");
  });
});

describe("moduleWaitingView", () => {
  it("puts the issue ahead of what is owed, and names it in the rule", () => {
    const v = moduleWaitingView(needsYou.waitingOn);
    expect(v).toMatchObject({ kind: "you", who: "You", act: "ISS-5 · make a decision", rule: "ISS-5: parked at needs_info" });
  });

  it("leaves a blocker's own key as the name, so the act does not repeat an issue", () => {
    const v = moduleWaitingView({ kind: "issue", who: "ISS-9", act: "not started", rule: "blocks it", ref: "ISS-9", issueKey: "ISS-7" });
    expect(v).toMatchObject({ kind: "issue", who: "ISS-9", act: "not started" });
  });

  it("reads a quiet module as nobody, with nothing to open", () => {
    expect(moduleWaitingView(standing().waitingOn)).toMatchObject({ kind: "none", who: "Nobody", act: "nothing open" });
  });
});

describe("ModuleBanner", () => {
  it("does not link the issue where the header already offers to open it", () => {
    render(<ModuleBanner standing={needsYou} slug="hop" />);
    expect(screen.getByTestId("module-banner").textContent).toBe("Waiting on you: ISS-5 make a decision");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links the leading issue where it is the only way in", () => {
    const stuck = standing({
      attentionGroup: "stuck",
      waitingOn: { kind: "issue", who: "ISS-9", act: "not started", rule: "blocks it", ref: "ISS-9", issueKey: "ISS-7" },
    });
    render(<ModuleBanner standing={stuck} slug="hop" />);
    expect(screen.getByTestId("module-banner").textContent).toBe("Stuck: ISS-7 waits on ISS-9 · not started");
    expect(screen.getByRole("link", { name: "ISS-7" })).toHaveAttribute("href", "/projects/hop/issues/ISS-7");
  });
});

describe("ModuleAction", () => {
  it("offers to open the issue that waits on you, and only then", () => {
    push.mockClear();
    const { unmount } = render(<ModuleAction standing={needsYou} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: "Open ISS-5" }));
    expect(push).toHaveBeenCalledWith("/projects/hop/issues/ISS-5");
    unmount();
    const { container } = render(<ModuleAction standing={standing({ attentionGroup: "moving" })} slug="hop" />);
    expect(container.firstChild).toBeNull();
  });
});
