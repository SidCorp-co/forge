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

vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects: PROJECTS, isLoading: false }),
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
