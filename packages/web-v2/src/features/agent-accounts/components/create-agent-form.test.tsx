// @vitest-environment jsdom
//
// ISS-1093 — the create-agent form, which is the first caller
// `POST /api/orgs/:orgId/agents` has ever had.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateAgentForm, handleProblem } from "./create-agent-form";

expect.extend(matchers);

const create = vi.fn(async (input: { handle: string; projectIds: string[] }) => ({
  handle: input.handle,
  plaintext: "forge_pat_secret",
}));
let projects = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
];

vi.mock("../hooks", () => ({
  useCreateAgent: () => ({ mutateAsync: create, isPending: false, isError: false, error: null }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects, isLoading: false }),
}));

beforeEach(() => {
  create.mockClear();
  projects = [
    { id: "p1", name: "Alpha" },
    { id: "p2", name: "Beta" },
  ];
});
afterEach(cleanup);

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("what the form sends", () => {
  // cm:guard `projectIds` PLURAL, with both ticked projects in it. The route's body schema
  // is `.strict()`, so a form sending the old singular `projectId` is refused by name — but
  // a form sending only the FIRST of several is accepted, and creates an agent whose
  // credential silently reaches one project. That is the exact shape `mintAgentCredential`'s
  // `.limit(1)` had, arriving from the other end.
  it("sends every project the admin ticked", async () => {
    render(<CreateAgentForm orgId="org-1" />);
    type("Handle", "forge-vm");
    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(create).toHaveBeenCalledWith({ handle: "forge-vm", projectIds: ["p1", "p2"] });
    expect(await screen.findByText("forge_pat_secret")).toBeInTheDocument();
  });

  it("does not call the route at all with no project ticked", () => {
    render(<CreateAgentForm orgId="org-1" />);
    type("Handle", "forge-vm");
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText("Pick at least one project.")).toBeInTheDocument();
  });

  it("does not call the route with a handle the server would refuse", () => {
    render(<CreateAgentForm orgId="org-1" />);
    type("Handle", "Forge VM");
    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("says why an org with no projects cannot have an agent yet", () => {
    projects = [];
    render(<CreateAgentForm orgId="org-1" />);
    expect(screen.getByText(/no projects yet/)).toBeInTheDocument();
  });
});

describe("the handle rule the form states before the round trip", () => {
  it.each([
    ["", /needs a handle/],
    ["Forge", /lowercase/],
    ["ab", /3–40/],
    ["a0", /3–40/],
    ["-forge", /3–40/],
    ["forge-", /3–40/],
    ["forge_vm", /3–40/],
    ["a".repeat(41), /3–40/],
  ])("refuses %j", (input, expected) => {
    expect(handleProblem(input)).toMatch(expected);
  });

  it.each(["forge-vm", "abc", "a0b", "a".repeat(40)])("accepts %j", (input) => {
    expect(handleProblem(input)).toBeNull();
  });
});
