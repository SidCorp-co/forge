// @vitest-environment jsdom
//
// ISS-1229 r48: with the organizations read failed, the new-project dialog hid its Organization
// picker and created the project in the personal workspace, as if the reader belonged to no team.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

const create = vi.fn(async () => ({ id: "p1", slug: "desk", name: "Desk", orgId: "o1" }));
const orgsRefetch = vi.fn();
let orgsFail = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: null }) }));
vi.mock("@/features/orgs/hooks", () => ({
  useOrgs: () =>
    orgsFail
      ? { data: undefined, isError: true, error: new Error("The server is down."), refetch: orgsRefetch }
      : { data: [{ id: "o1", name: "SidCorp", isPersonal: false }], isError: false, error: null, refetch: orgsRefetch },
}));
vi.mock("@/features/project-settings/hooks", () => ({
  useUpdateProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../hooks", () => ({
  useCreateProject: () => ({ mutateAsync: create, reset: vi.fn(), isPending: false }),
  useOnboardProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { NewProjectDialog } = await import("./new-project-dialog");

function submitDesk() {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Desk" } });
  fireEvent.submit(screen.getByLabelText(/^Name/).closest("form") as HTMLFormElement);
}

beforeEach(() => {
  orgsFail = true;
  create.mockClear();
  orgsRefetch.mockClear();
});

describe("the new-project dialog while the organizations read failed", () => {
  it("says so with Retry where the Organization picker stands", () => {
    render(<NewProjectDialog open onClose={vi.fn()} />);
    const unread = screen.getByTestId("new-project-orgs-unread");
    expect(unread).toHaveTextContent(
      "Couldn't load your organizations, so where this project will live is not known. The server is down.",
    );
    fireEvent.click(within(unread).getByRole("button", { name: "Retry" }));
    expect(orgsRefetch).toHaveBeenCalledTimes(1);
  });

  it("creates nothing, rather than creating it in the personal workspace", () => {
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submitDesk();
    expect(create).not.toHaveBeenCalled();
  });

  it("offers the picker and creates once the read answers", async () => {
    orgsFail = false;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.queryByTestId("new-project-orgs-unread")).toBeNull();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    submitDesk();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});
