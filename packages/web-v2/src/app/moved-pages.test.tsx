// REQ-33 BC-1: the project's Decisions, Roadmap and Memory pages are gone from the menu. A link to one
// kept from before lands where that record is read now, and the page it lands on says so in one line.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movedTarget } from "@/features/shell/moved";
import { MovedNotice } from "@/features/shell/components/moved-notice";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace }), useParams: () => ({ slug: "hop" }), usePathname: () => "/projects/hop" }));

import DecisionsPage from "./(workspace)/projects/[slug]/decisions/page";
import MemoryPage from "./(workspace)/projects/[slug]/memory/page";
import RoadmapPage from "./(workspace)/projects/[slug]/roadmap/page";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  replace.mockClear();
});

const at = (path: string) => window.history.replaceState(null, "", path);

describe("an old Decisions, Roadmap or Memory link", () => {
  it("names where each record is read now, keeping the record an old decision-log filter named", () => {
    const none = new URLSearchParams();
    expect(movedTarget("hop", "decisions", none)).toBe("/projects/hop/requirements?moved=decisions");
    expect(movedTarget("hop", "decisions", new URLSearchParams("requirement=REQ-14"))).toBe("/projects/hop/requirements/REQ-14?tab=decisions&moved=decisions");
    expect(movedTarget("hop", "decisions", new URLSearchParams("workflow=intake"))).toBe("/projects/hop/workflows/intake?tab=decisions&moved=decisions");
    expect(movedTarget("hop", "decisions", new URLSearchParams("issue=ISS-110"))).toBe("/projects/hop/issues/ISS-110?tab=activity&moved=decisions");
    expect(movedTarget("hop", "roadmap", none)).toBe("/projects/hop/requirements?group=roadmap&moved=roadmap");
    expect(movedTarget("hop", "memory", none)).toBe("/projects/hop/requirements?moved=memory");
  });

  it("replaces the old page with the place that holds its record", () => {
    at("/projects/hop/decisions?requirement=REQ-14");
    render(<DecisionsPage />);
    expect(replace).toHaveBeenCalledWith("/projects/hop/requirements/REQ-14?tab=decisions&moved=decisions");
    at("/projects/hop/roadmap");
    render(<RoadmapPage />);
    expect(replace).toHaveBeenLastCalledWith("/projects/hop/requirements?group=roadmap&moved=roadmap");
    at("/projects/hop/memory");
    render(<MemoryPage />);
    expect(replace).toHaveBeenLastCalledWith("/projects/hop/requirements?moved=memory");
  });

  it("says on the page it lands on where the record went, once, and goes when dismissed", async () => {
    at("/projects/hop/requirements?group=roadmap&moved=roadmap");
    render(<MovedNotice />);
    expect(screen.getByTestId("moved-notice")).toHaveTextContent("The Roadmap page is gone: Now, Next and Later are a grouping of the Requirements list");
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("moved-notice")).toBeNull();
    expect(window.location.search).toBe("?group=roadmap");
  });

  it("says nothing on a page no old link led to, nor for a moved value no page had", () => {
    at("/projects/hop/requirements?moved=settings");
    const { container } = render(<MovedNotice />);
    expect(container).toBeEmptyDOMElement();
  });
});
