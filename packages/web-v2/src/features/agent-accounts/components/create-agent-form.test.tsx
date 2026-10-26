// @vitest-environment jsdom
//
// ISS-1169: the form submits exactly the projects chosen through the picker, and refuses with a reason
// when none is.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const create = vi.fn(async () => ({ handle: "forge-vm", plaintext: "forge_pat_secret" }));
const PROJECTS = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, name: `project-${i}` }));

const read = { error: null as unknown };
const readProjects = vi.fn(() => {
  read.error = null;
});
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({
    projects: read.error ? [] : PROJECTS,
    isLoading: false,
    error: read.error,
    refetch: readProjects,
  }),
}));
vi.mock("../hooks", () => ({
  useCreateAgent: () => ({ mutateAsync: create, isPending: false, isError: false }),
}));

import { CreateAgentForm } from "./create-agent-form";

beforeEach(() => create.mockClear());
afterEach(cleanup);

function choose(search: string, name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: search } });
  fireEvent.click(screen.getByRole("checkbox", { name }));
}

describe("CreateAgentForm", () => {
  it("says what the projects are for in a sentence that parses", () => {
    render(<CreateAgentForm orgId="o1" />);
    expect(
      screen.getByText("Every project this agent works on. A box paired as this agent reaches these projects and no others."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/paired as it reaches/)).toBeNull();
  });

  it("sends exactly the chosen project ids with the handle", async () => {
    render(<CreateAgentForm orgId="o1" />);
    fireEvent.change(screen.getByPlaceholderText("forge-vm"), { target: { value: "forge-vm" } });
    choose("project-3", "project-3");
    choose("project-20", "project-20");
    fireEvent.click(screen.getByRole("button", { name: "Remove project-3" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ handle: "forge-vm", projectIds: ["p20"] });
  });

  it("refuses to send with no project chosen, and says so", () => {
    render(<CreateAgentForm orgId="o1" />);
    fireEvent.change(screen.getByPlaceholderText("forge-vm"), { target: { value: "forge-vm" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText("Pick at least one project.")).toBeInTheDocument();
  });
});

// ISS-1229 r47: a failed projects read said "This organization has no projects yet", which was false.
describe("CreateAgentForm when the projects cannot be read", () => {
  it("says the read failed and offers Retry, never that the organization has no projects", () => {
    read.error = new Error("The server ran into a problem and could not finish the request.");
    const { rerender } = render(<CreateAgentForm orgId="o1" />);
    expect(screen.getByTestId("agent-projects-unread")).toHaveTextContent(
      "This organization's projects could not be read: The server ran into a problem and could not finish the request.",
    );
    expect(screen.queryByText(/has no projects yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(readProjects).toHaveBeenCalledTimes(1);
    rerender(<CreateAgentForm orgId="o1" />);
    expect(screen.queryByTestId("agent-projects-unread")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search projects" })).toBeInTheDocument();
  });
});
