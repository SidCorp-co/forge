// @vitest-environment jsdom
//
// ISS-1229 r48: a choice read from a list hid itself, or offered nothing, where that list's read failed —
// the organization's members to add to a project, the organizations to move it to, the devices to assign.
// A failed read is said where the choice would be, with Retry, never as a choice holding nothing.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";

expect.extend(matchers);

const down = new Error("The server is down.");
const reads = vi.hoisted(() => ({
  projectsFail: false,
  orgMembersFail: false,
  orgsFail: false,
  devicesFail: false,
  refetchProjects: vi.fn(),
  refetchOrgMembers: vi.fn(),
  refetchOrgs: vi.fn(),
  refetchDevices: vi.fn(),
}));
const idle = { mutate: vi.fn(), isPending: false, isError: false };
const read = <T,>(failed: boolean, data: T, refetch: () => void) =>
  failed
    ? { data: undefined, isLoading: false, isError: true, error: down, refetch }
    : { data, isLoading: false, isError: false, error: null, refetch };

vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () =>
    read(reads.projectsFail, [{ id: "p1", orgId: "o1", orgIsPersonal: false }], reads.refetchProjects),
}));
vi.mock("@/features/orgs/hooks", () => ({
  useOrgMembers: () => read(reads.orgMembersFail, [{ userId: "u9", email: "nine@example.test" }], reads.refetchOrgMembers),
  useOrgs: () => read(reads.orgsFail, [{ id: "o2", name: "Other", role: "owner" }], reads.refetchOrgs),
}));
vi.mock("../hooks", () => ({
  useMembers: () => ({ data: [], isLoading: false, isError: false }),
  useInvitations: () => ({ data: [], isLoading: false, isError: false }),
  useInviteMember: () => idle,
  useRemoveMember: () => idle,
  useRevokeInvitation: () => idle,
  useUpdateMemberRole: () => idle,
  useDirectAddMember: () => idle,
  useArchiveProject: () => idle,
  useUnarchiveProject: () => idle,
  useUpdateProject: () => idle,
}));
vi.mock("@/features/runners/hooks", async (importActual) => {
  const actual = await importActual<typeof import("@/features/runners/hooks")>();
  return {
    ...actual,
    useDevices: () => read(reads.devicesFail, [], reads.refetchDevices),
    useAssignDeviceToProject: () => idle,
    useInitPairing: () => idle,
  };
});

const { MembersTab } = await import("./members-tab");
const { MoveToOrgCard } = await import("./advanced-tab");
const { AssignDevice } = await import("@/features/runners/components/project-runners-screen");

beforeEach(() => {
  reads.projectsFail = false;
  reads.orgMembersFail = false;
  reads.orgsFail = false;
  reads.devicesFail = false;
  for (const f of [reads.refetchProjects, reads.refetchOrgMembers, reads.refetchOrgs, reads.refetchDevices]) f.mockClear();
});
afterEach(cleanup);

describe("Add from organization, on a project's Members", () => {
  it("says the organization's members could not be loaded, and Retry reads them again", () => {
    reads.orgMembersFail = true;
    render(<MembersTab projectId="p1" canEdit />);
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load the organization's members. The server is down.");
    fireEvent.click(within(failure.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(reads.refetchOrgMembers).toHaveBeenCalledTimes(1);
  });

  it("says the projects could not be loaded where they decide the organization, and Retry reads them again", () => {
    reads.projectsFail = true;
    render(<MembersTab projectId="p1" canEdit />);
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load your projects, so this project's organization is not known.");
    fireEvent.click(within(failure.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(reads.refetchProjects).toHaveBeenCalledTimes(1);
  });
});

describe("Move to organization, on a project's Advanced", () => {
  const project = { id: "p1", name: "Desk" } as ProjectDetail;

  it("says the organizations could not be loaded, never leaving the section out, and Retry reads them again", () => {
    reads.orgsFail = true;
    render(<MoveToOrgCard project={project} />);
    expect(screen.getByRole("heading", { name: "Move to organization" })).toBeInTheDocument();
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load your organizations. The server is down.");
    fireEvent.click(within(failure.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(reads.refetchOrgs).toHaveBeenCalledTimes(1);
  });
});

describe("Add a device, on a project's Runners", () => {
  it("says the devices could not be loaded where the picker would be, and Retry reads them again", () => {
    reads.devicesFail = true;
    render(<AssignDevice projectId="p1" defaultRepoPath={null} assignedDeviceIds={new Set()} hasRepoUrl />);
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load your devices. The server is down.");
    fireEvent.click(within(failure.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(reads.refetchDevices).toHaveBeenCalledTimes(1);
  });
});
