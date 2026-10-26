// @vitest-environment jsdom
//
// ISS-1229 r47: with the projects read failing, the rail offered "Add" as if the organization held no
// project, the phone drawer said "No projects yet." and the flyout "No projects match.". A failed read is
// said, with the act that reads it again, never shown as a list holding nothing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const { MobileNavDrawer } = await import("./components/mobile-nav-drawer");
const { ProjectFlyout } = await import("@/features/projects/components/project-flyout");

afterEach(() => {
  cleanup();
  read.failed = true;
  read.refetched = 0;
});

const unread = (onRetry: () => void) => ({ message: "The server ran into a problem and could not finish the request.", onRetry });

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
