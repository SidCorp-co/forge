// REQ-33 BC-1, BC-8, BC-9: the project's Decisions, Roadmap, Memory, Questions and Lessons pages are gone
// from the menu. A link to one kept from before lands where that record is read now, and the page it
// lands on says so in one line; lessons are read by no person, so their old link says that instead.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movedTarget } from "@/features/shell/moved";
import { MovedNotice } from "@/features/shell/components/moved-notice";
import { componentOf } from "@/test/route-tree";

const replace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace }), useParams: () => ({ slug: "hop" }), usePathname: () => "/projects/hop" }));

import { Route as DecisionsRoute } from "./_workspace/projects/$slug/decisions/index";
import { Route as MemoryRoute } from "./_workspace/projects/$slug/memory/index";
import { Route as RoadmapRoute } from "./_workspace/projects/$slug/roadmap/index";
import { Route as QuestionsRoute } from "./_workspace/projects/$slug/questions/index";
import { Route as LessonsRoute } from "./_workspace/projects/$slug/lessons/index";

const DecisionsPage = componentOf(DecisionsRoute, "routes/_workspace/projects/$slug/decisions/index.tsx");
const MemoryPage = componentOf(MemoryRoute, "routes/_workspace/projects/$slug/memory/index.tsx");
const RoadmapPage = componentOf(RoadmapRoute, "routes/_workspace/projects/$slug/roadmap/index.tsx");
const QuestionsPage = componentOf(QuestionsRoute, "routes/_workspace/projects/$slug/questions/index.tsx");
const LessonsPage = componentOf(LessonsRoute, "routes/_workspace/projects/$slug/lessons/index.tsx");

afterEach(() => {
  window.history.replaceState(null, "", "/");
  replace.mockClear();
});

const at = (path: string) => window.history.replaceState(null, "", path);

describe("an old Decisions, Roadmap or Memory link", () => {
  it("names where each record is read now, keeping the record an old decision-log filter named", () => {
    const none = new URLSearchParams();
    expect(movedTarget("hop", "decisions", none)).toBe("/projects/hop/requirements?moved=decisions");
    expect(movedTarget("hop", "decisions", new URLSearchParams("requirement=REQ-14"))).toBe("/projects/hop/requirements/REQ-14?tab=activity&moved=decisions");
    expect(movedTarget("hop", "decisions", new URLSearchParams("workflow=intake"))).toBe("/projects/hop/workflows/intake?tab=decisions&moved=decisions");
    expect(movedTarget("hop", "decisions", new URLSearchParams("issue=ISS-110"))).toBe("/projects/hop/issues/ISS-110?view=developer&moved=decisions");
    expect(movedTarget("hop", "roadmap", none)).toBe("/projects/hop/requirements?group=map&moved=roadmap");
    expect(movedTarget("hop", "memory", none)).toBe("/projects/hop?moved=memory#project-memory");
    expect(movedTarget("hop", "questions", none)).toBe("/projects/hop/approvals?moved=questions");
    expect(movedTarget("hop", "lessons", none)).toBe("/projects/hop?moved=lessons");
  });

  it("replaces the old page with the place that holds its record", () => {
    at("/projects/hop/decisions?requirement=REQ-14");
    render(<DecisionsPage />);
    expect(replace).toHaveBeenCalledWith("/projects/hop/requirements/REQ-14?tab=activity&moved=decisions");
    at("/projects/hop/roadmap");
    render(<RoadmapPage />);
    expect(replace).toHaveBeenLastCalledWith("/projects/hop/requirements?group=map&moved=roadmap");
    at("/projects/hop/memory");
    render(<MemoryPage />);
    expect(replace).toHaveBeenLastCalledWith("/projects/hop?moved=memory#project-memory");
    at("/projects/hop/questions");
    render(<QuestionsPage />);
    expect(replace).toHaveBeenLastCalledWith("/projects/hop/approvals?moved=questions");
    at("/projects/hop/lessons");
    render(<LessonsPage />);
    expect(replace).toHaveBeenLastCalledWith("/projects/hop?moved=lessons");
  });

  it("says where questions are read now, and that lessons are shown to no one", () => {
    at("/projects/hop/approvals?moved=questions");
    const { unmount } = render(<MovedNotice />);
    expect(screen.getByTestId("moved-notice")).toHaveTextContent("Questions moved to Approvals and to the item each one is about.");
    unmount();
    at("/projects/hop?moved=lessons");
    render(<MovedNotice />);
    expect(screen.getByTestId("moved-notice")).toHaveTextContent("Lessons are internal to Forge, and no page shows them.");
  });

  it("says on the page it lands on where the record went, once, and goes when dismissed", async () => {
    at("/projects/hop/requirements?group=map&moved=roadmap");
    render(<MovedNotice />);
    expect(screen.getByTestId("moved-notice")).toHaveTextContent("Roadmap moved to the Requirements Map");
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("moved-notice")).toBeNull();
    expect(window.location.search).toBe("?group=map");
  });

  it("says nothing on a page no old link led to, nor for a moved value no page had", () => {
    at("/projects/hop/requirements?moved=settings");
    const { container } = render(<MovedNotice />);
    expect(container).toBeEmptyDOMElement();
  });
});
