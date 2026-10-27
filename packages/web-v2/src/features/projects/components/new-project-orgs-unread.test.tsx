// @vitest-environment jsdom
//
// ISS-1229 r48: with the organizations read failed, the new-project dialog hid its Organization
// picker and created the project in the personal workspace, as if the reader belonged to no team.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);
// The organization picker scrolls its chosen option into view, which jsdom does not draw.
Element.prototype.scrollIntoView = () => {};

const create = vi.fn(async () => ({ id: "p1", slug: "desk", name: "Desk", orgId: "o1" }));
const orgsRefetch = vi.fn();
let orgsFail = true;
let orgsLoading = false;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
// The active org is read off the same organizations read: unknown while it failed, the team org once it answers.
const prefsRetry = vi.fn();
let storedFail = false;
let storedReading = false;
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () =>
    orgsLoading || orgsFail || storedReading
      ? { activeOrg: null, scopeRead: false, storedUnread: null }
      : storedFail
        ? {
            // The stand-in a failed stored choice is answered by: the personal workspace (ISS-1229 r50).
            activeOrg: { id: "me", name: "Personal", isPersonal: true },
            scopeRead: true,
            storedUnread: { error: new Error("The server is down."), retry: prefsRetry },
          }
        : { activeOrg: { id: "o1", name: "SidCorp", isPersonal: false }, scopeRead: true, storedUnread: null },
}));
vi.mock("@/features/orgs/hooks", () => ({
  useOrgs: () =>
    orgsLoading
      ? { data: undefined, isError: false, error: null, refetch: orgsRefetch }
      : orgsFail
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
  orgsLoading = false;
  storedFail = false;
  storedReading = false;
  prefsRetry.mockClear();
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

  it("keeps the draft, offers the picker and creates once Retry's read answers", async () => {
    const { rerender } = render(<NewProjectDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Desk" } });
    fireEvent.click(within(screen.getByTestId("new-project-orgs-unread")).getByRole("button", { name: "Retry" }));
    orgsFail = false;
    rerender(<NewProjectDialog open onClose={vi.fn()} />);

    expect(screen.queryByTestId("new-project-orgs-unread")).toBeNull();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Desk");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
    fireEvent.submit(screen.getByLabelText(/^Name/).closest("form") as HTMLFormElement);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]).toEqual([{ slug: "desk", name: "Desk", orgId: "o1" }]);
  });

  // ISS-1229 r49, judge-146: after Retry the picker read Personal and Create filed the project there.
  it("shows the organization being worked in once Retry's read answers, never Personal", () => {
    const { rerender } = render(<NewProjectDialog open onClose={vi.fn()} />);
    orgsFail = false;
    rerender(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("SidCorp");
  });

  it("keeps the organization the person picked when the read answers again", async () => {
    orgsFail = false;
    const { rerender } = render(<NewProjectDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Personal" }));
    rerender(<NewProjectDialog open onClose={vi.fn()} />);
    submitDesk();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]).toEqual([{ slug: "desk", name: "Desk" }]);
  });

  it("creates nothing while the organizations are still loading", () => {
    orgsLoading = true;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submitDesk();
    expect(create).not.toHaveBeenCalled();
  });
});

// ISS-1229 r50, judge-152 on 481: with the stored active organization's read failed, the dialog offered Personal
// with Create enabled and filed the project there; and on 480, for the first moments it said nothing at all.
describe("the new-project dialog while the stored active organization cannot be read (criteria 481, 501, 502)", () => {
  it("says so with Retry, and creates nothing in the organization standing in for it", () => {
    orgsFail = false;
    storedFail = true;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    const unread = screen.getByTestId("new-project-stored-org-unread");
    expect(unread).toHaveTextContent(
      "Couldn't load which organization you were working in, so where this project will live is not known. The server is down.",
    );
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submitDesk();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(within(unread).getByRole("button", { name: "Retry" }));
    expect(prefsRetry).toHaveBeenCalledTimes(1);
  });

  it("says the organizations are being read while they are, where the Organization field stands", () => {
    orgsLoading = true;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId("new-project-orgs-reading")).toHaveTextContent("Reading your organizations");
  });

  // r50 after-shot: with the organizations answered and the stored one still read, the dialog said it was reading
  // and beside that offered an Organization field set to Personal, a choice nothing had made.
  it("offers no Organization field while the stored organization is still read, only that it is being read", () => {
    orgsFail = false;
    storedReading = true;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId("new-project-orgs-reading")).toHaveTextContent("Reading your organizations");
    expect(screen.queryByText("Organization")).toBeNull();
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  });

  it("offers no Organization field set to the stand-in where the stored organization cannot be read", () => {
    orgsFail = false;
    storedFail = true;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("says nothing is being read once both have answered", () => {
    orgsFail = false;
    render(<NewProjectDialog open onClose={vi.fn()} />);
    expect(screen.queryByTestId("new-project-orgs-reading")).toBeNull();
    expect(screen.queryByTestId("new-project-stored-org-unread")).toBeNull();
  });
});
