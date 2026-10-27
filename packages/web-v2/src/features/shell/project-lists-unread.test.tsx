// @vitest-environment jsdom
//
// ISS-1229 r47: with the projects read failing, the rail offered "Add" as if the organization held no
// project, the phone drawer said "No projects yet." and the flyout "No projects match.". A failed read is
// said, with the act that reads it again, never shown as a list holding nothing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const read = vi.hoisted(() => ({ failed: true, refetched: 0 }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () =>
    read.failed
      ? {
          data: undefined,
          isError: true,
          error: new Error("The server ran into a problem and could not finish the request."),
          refetch: () => {
            read.refetched += 1;
          },
        }
      : { data: [], isError: false, error: null, refetch: () => {} },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/features/orgs/components/org-switcher", () => ({ OrgSwitcher: () => null }));

const { NavRailCompact } = await import("./nav-rail-compact");
const { projectsUnreadOf, ProjectsUnreadLine } = await import("@/features/projects/components/projects-unread");
const { NavRail } = await import("@/design/patterns/nav-rail");
const { ApiError } = await import("@/lib/api/client");
const { MobileNavDrawer } = await import("./components/mobile-nav-drawer");
const { ProjectFlyout } = await import("@/features/projects/components/project-flyout");

afterEach(() => {
  cleanup();
  read.failed = true;
  read.refetched = 0;
});

const unread = (onRetry: () => void, error: unknown = new ApiError(500, "")) => projectsUnreadOf(error, onRetry);

describe("a project list whose read failed", () => {
  it("is said on the narrow rail, with Retry, where Add stood for an organization holding none", () => {
    const onRetry = vi.fn();
    render(
      <NavRailCompact
        workspaceItems={[{ key: "overview", label: "Overview", icon: "grid" }]}
        activeKey="overview"
        switcherProjects={[]}
        projectsUnread={unread(onRetry)}
        onNavigate={() => {}}
        onSelectProject={() => {}}
        onTogglePin={() => {}}
        onAllProjects={() => {}}
        onNewProject={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Couldn't load your projects. Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // ISS-1229 r48, judge-142: the only visible word was "Retry", and the hover title was the server's sentence.
  it("says on the narrow rail, as visible text, that the projects were not loaded, and its tooltip names them", () => {
    render(
      <NavRailCompact
        workspaceItems={[{ key: "overview", label: "Overview", icon: "grid" }]}
        activeKey="overview"
        switcherProjects={[]}
        projectsUnread={unread(() => {})}
        onNavigate={() => {}}
        onSelectProject={() => {}}
        onTogglePin={() => {}}
        onAllProjects={() => {}}
        onNewProject={() => {}}
      />,
    );
    const retry = screen.getByTestId("rail-projects-unread");
    expect(retry).toHaveTextContent(/^Projects not loadedRetry$/);
    expect(retry).toHaveAttribute("title", "Couldn't load your projects. Retry");
    expect(retry.getAttribute("title")).not.toContain("server");
  });

  it("is said in the phone drawer, with Retry, never as no projects yet", () => {
    const onRetry = vi.fn();
    render(
      <MobileNavDrawer
        open
        onClose={() => {}}
        slug={null}
        railSlug={null}
        railProjectName={null}
        activeKey="overview"
        attention={{}}
        openWork={{}}
        scopedProjects={[]}
        projectsUnread={unread(onRetry)}
        onNavigate={() => {}}
        onOpenProject={() => {}}
        onCreateProject={() => {}}
        onViewAllProjects={() => {}}
      />,
    );
    const line = screen.getByTestId("projects-unread");
    expect(line).toHaveTextContent("Couldn't load your projects");
    expect(screen.queryByText("No projects yet.")).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("is said in the expanded rail's flyout, with Retry that reads the projects again, never as no match", () => {
    render(<ProjectFlyout open onClose={() => {}} activeSlug={null} />);
    const line = screen.getByTestId("projects-unread");
    expect(line).toHaveTextContent("Couldn't load your projects");
    expect(screen.queryByText("No projects match.")).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(read.refetched).toBe(1);
  });

  it("still says no project matches where the read answered with none", () => {
    read.failed = false;
    render(<ProjectFlyout open onClose={() => {}} activeSlug={null} />);
    expect(screen.getByText("No projects match.")).toBeTruthy();
    expect(screen.queryByTestId("projects-unread")).toBeNull();
  });
});

const railWith = (projectsUnread: ReturnType<typeof unread>) => (
  <NavRailCompact
    workspaceItems={[{ key: "overview", label: "Overview", icon: "grid" }]}
    activeKey="overview"
    switcherProjects={[]}
    projectsUnread={projectsUnread}
    onNavigate={() => {}}
    onSelectProject={() => {}}
    onTogglePin={() => {}}
    onAllProjects={() => {}}
    onNewProject={() => {}}
  />
);

// ISS-1229 r50, judge-152 on 479: "Projects not loaded / Retry" gave no wait where the answer carried Retry-After,
// and on 478: it offered Retry on a refusal no second read changes.
describe("the narrow rail's failed projects read (criteria 497, 498)", () => {
  // ISS-1229 r51, judge-158: 47 seconds after a 30-second Retry-After the tile still said 30, and its name said
  // the wait twice. It counts down, offers Retry once the wait is over, and names each thing once.
  it("counts the wait down in visible text, and offers Retry once it is over", () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      render(railWith(unread(onRetry, new ApiError(429, "", undefined, undefined, undefined, 30_000))));
      const tile = () => screen.getByTestId("rail-projects-unread");
      expect(tile()).toHaveTextContent("You can retry in 30 seconds.");
      expect(tile()).toHaveTextContent("Projects not loaded");
      expect(tile()).not.toHaveAttribute("role");
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
      act(() => void vi.advanceTimersByTime(17_000));
      expect(screen.getByRole("timer")).toHaveTextContent("You can retry in 13 seconds.");
      act(() => void vi.advanceTimersByTime(13_000));
      expect(screen.queryByTestId("rail-projects-wait")).toBeNull();
      const retry = screen.getByRole("button", { name: "Couldn't load your projects. Retry" });
      fireEvent.click(retry);
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ISS-1229 r52, judge-162: the tile was a status whose name held the count, so a screen reader announced it every
  // second. The count is a timer, which is read when asked; a status says the wait as it starts and as it ends.
  it("announces the wait as it starts and as it ends, and nothing while it counts", () => {
    vi.useFakeTimers();
    try {
      render(railWith(unread(() => {}, new ApiError(429, "", undefined, undefined, undefined, 30_000))));
      const live = () => screen.getAllByRole("status").map((s) => s.textContent ?? "");
      const started = live();
      expect(started).toEqual(["The server asked for 30 seconds before Retry."]);
      for (const step of [1_000, 4_000, 12_000, 12_000]) {
        act(() => void vi.advanceTimersByTime(step));
        expect(live()).toEqual(started);
        expect(screen.getByRole("timer")).toHaveTextContent(/You can retry in \d+ seconds?\./);
      }
      act(() => void vi.advanceTimersByTime(1_100));
      expect(live()).toEqual(["You can retry now."]);
      expect(screen.getByRole("button", { name: "Couldn't load your projects. Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says no wait where the rule offers no Retry, though the answer carried Retry-After", () => {
    render(railWith(unread(() => {}, new ApiError(403, "You do not have access to this.", undefined, undefined, undefined, 60_000))));
    const tile = screen.getByTestId("rail-projects-unread");
    expect(tile).not.toHaveTextContent(/retry in/i);
    expect(tile.getAttribute("aria-label")).toBe("Couldn't load your projects. You do not have access to this.");
  });

  it.each([403, 404, 422])("offers no Retry where the read was answered %s, and says why", (status) => {
    render(railWith(unread(() => {}, new ApiError(status, "You do not have access to this."))));
    const tile = screen.getByTestId("rail-projects-unread");
    expect(tile.tagName).not.toBe("BUTTON");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(tile).toHaveTextContent("Projects not loaded");
    expect(tile.getAttribute("aria-label")).toBe("Couldn't load your projects. You do not have access to this.");
  });
});

// ISS-1229 r50, judge-152 on 451: with the sidebar expanded, a failed projects read dropped the project section,
// line for line the sidebar of an organization holding no projects.
describe("the expanded sidebar's failed projects read (criterion 499)", () => {
  it("is said where the project switcher stands, with Retry", () => {
    const onRetry = vi.fn();
    render(
      <NavRail
        workspaceItems={[{ key: "overview", label: "Overview", icon: "grid" }]}
        activeKey="overview"
        projectsUnread={<ProjectsUnreadLine unread={unread(onRetry)} />}
      />,
    );
    const line = screen.getByTestId("projects-unread");
    expect(line).toHaveTextContent("Couldn't load your projects");
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("is not drawn where a project is open", () => {
    render(
      <NavRail
        workspaceItems={[{ key: "overview", label: "Overview", icon: "grid" }]}
        activeKey="overview"
        project={{ name: "Desk", initials: "DE", tint: "#000", ink: "#fff" }}
        projectsUnread={<ProjectsUnreadLine unread={unread(() => {})} />}
      />,
    );
    expect(screen.queryByTestId("projects-unread")).toBeNull();
  });
});
