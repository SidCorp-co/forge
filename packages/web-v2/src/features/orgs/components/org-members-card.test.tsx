// @vitest-environment jsdom
//
// ISS-1229 r25 after-shot: at 390 wide each member's row gave the lens chips, role picker and remove
// control their width and left one or two characters of who the member is.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { OrgMembersCard } from "./org-members-card";

const idle = { mutate: vi.fn(), isPending: false, isError: false };
const toast = vi.fn();
let refusal: ApiError | null = null;
/** A mutation that is refused with `refusal` where one is set. */
const refusing = {
  isPending: false,
  isError: false,
  mutate: (_arg: unknown, opts?: { onError?: (err: unknown) => void; onSuccess?: () => void }) =>
    refusal ? opts?.onError?.(refusal) : opts?.onSuccess?.(),
};
const person = (userId: string, email: string, displayName: string | null, role: string, createdAt: string) => ({
  userId, email, displayName, role, lenses: [], createdAt, kind: "person", projects: [],
});
let members: unknown[] = [];
vi.mock("../hooks", () => ({
  useOrgMembers: () => ({
    isLoading: false,
    isError: false,
    data: members,
  }),
  useOrgProjects: () => ({ isLoading: false, isError: false, data: [] }),
  useOrgInvitations: () => ({ isLoading: false, isError: false, data: [] }),
  useAddOrgMember: () => idle,
  useDeleteOrg: () => refusing,
  useRemoveOrgMember: () => idle,
  useRenameOrg: () => refusing,
  useRevokeOrgInvitation: () => idle,
  useUpdateOrgMemberLenses: () => idle,
  useUpdateOrgMemberRole: () => idle,
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

afterEach(cleanup);
beforeEach(() => {
  toast.mockClear();
  refusal = null;
  members = [
    { ...person("me", "lan@example.com", "Lan", "owner", "2026-10-01T09:00:00Z"), lenses: ["technical"] },
    person("u2", "a-long-address-for-a-member@example.com", "Mai Tran", "member", "2026-10-02T09:00:00Z"),
    person("u3", "unnamed@example.com", null, "member", "2026-10-03T09:00:00Z"),
  ];
});

const card = () =>
  render(<OrgMembersCard org={{ id: "o1", name: "Northwind", slug: "northwind", role: "owner" } as never} onDeleted={() => {}} />);

describe("a member's row on the organization page", () => {
  it("wraps its controls under the member rather than squeezing who the member is", () => {
    render(<OrgMembersCard org={{ id: "o1", name: "Northwind", slug: "northwind", role: "owner" } as never} onDeleted={() => {}} />);
    const rows = screen.getAllByTestId("org-member-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.classList.contains("flex-wrap")).toBe(true);
      const who = row.querySelector("[data-testid=org-member-who]");
      expect(who?.classList.contains("min-w-[12rem]")).toBe(true);
      expect(who?.classList.contains("flex-1")).toBe(true);
    }
  });

  // The master's read of the r25 shots: each row was its own bordered box inside the bordered card.
  it("is a flush row under a hairline, never a box of its own", () => {
    render(<OrgMembersCard org={{ id: "o1", name: "Northwind", slug: "northwind", role: "owner" } as never} onDeleted={() => {}} />);
    for (const row of screen.getAllByTestId("org-member-row")) {
      expect(row.className).not.toMatch(/\bborder\b|\brounded/);
      expect(row.parentElement?.classList.contains("divide-y")).toBe(true);
    }
  });

  // Round 27, judge-77: each row showed only the member's address, never the name they gave.
  it("names each member first, You for the reader, with the address under the name", () => {
    render(<OrgMembersCard org={{ id: "o1", name: "Northwind", slug: "northwind", role: "owner" } as never} onDeleted={() => {}} />);
    const read = screen.getAllByTestId("org-member-row").map((row) => [
      row.querySelector("[data-testid=org-member-name]")?.textContent,
      row.querySelector("[data-testid=org-member-email]")?.textContent,
    ]);
    expect(read).toEqual([
      ["You", "lan@example.com"],
      ["Mai Tran", "a-long-address-for-a-member@example.com"],
      ["Another member", "unnamed@example.com"],
    ]);
    const who = screen.getAllByTestId("org-member-who")[1];
    expect(who.firstElementChild?.getAttribute("data-testid")).toBe("org-member-name");
    expect(screen.getByRole("button", { name: "Remove Mai Tran, a-long-address-for-a-member@example.com" })).toBeTruthy();
  });
});

// ISS-1229 r28, judge-80: rows came in address order, so the reader read third; project agents were
// listed as members with lens chips, a role and a remove control, the agent of a deleted project too;
// leaving asked "Remove you … They lose access"; and a refused delete or rename was a toast drawn over
// the panel's own lines.
describe("the organization page's people and agents", () => {
  it("lists the reader first, then names in order, then the unnamed by when each joined", () => {
    members = [
      person("u-late", "a-late@example.com", null, "member", "2026-10-05T09:00:00Z"),
      person("u-zed", "b-zed@example.com", "Zed", "member", "2026-10-01T09:00:00Z"),
      person("me", "c-me@example.com", null, "owner", "2026-10-04T09:00:00Z"),
      person("u-early", "d-early@example.com", null, "member", "2026-10-02T09:00:00Z"),
      person("u-an", "e-an@example.com", "An", "admin", "2026-10-03T09:00:00Z"),
    ];
    card();
    const emails = screen.getAllByTestId("org-member-email").map((e) => e.textContent);
    expect(emails).toEqual([
      "c-me@example.com",
      "e-an@example.com",
      "b-zed@example.com",
      "d-early@example.com",
      "a-late@example.com",
    ]);
  });

  it("lists agents apart, each with the projects it serves and no control, and leaves out one serving none", () => {
    members = [
      ...members,
      { ...person("a1", "ops@agents.forge", null, "member", "2026-10-01T09:00:00Z"), kind: "agent", handle: "ops", projects: [{ id: "p1", name: "Billing" }, { id: "p2", name: "Ledger" }] },
      { ...person("a2", "retired@agents.forge", null, "member", "2026-10-01T09:00:00Z"), kind: "agent", handle: "retired", projects: [] },
    ];
    card();
    expect(screen.getAllByTestId("org-member-row")).toHaveLength(3);
    const agents = screen.getAllByTestId("org-agent-row");
    expect(agents.map((a) => a.textContent)).toEqual(["@opsBilling, Ledger"]);
    const [only] = agents;
    expect(within(only as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(within(only as HTMLElement).queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryByText("@retired")).toBeNull();
  });

  it("asks the reader taking themself out to leave, in their own words", () => {
    card();
    fireEvent.click(screen.getByRole("button", { name: "Leave Northwind" }));
    const panel = screen.getByRole("dialog");
    expect(panel.textContent).toContain("Leave Northwind? You lose access to all of its projects.");
    expect(within(panel).getByRole("button", { name: "Leave organization" })).toBeTruthy();
    expect(panel.textContent).not.toMatch(/Remove you|They lose access/);
  });

  it("tells a refused delete inside its panel, under the question, and in no toast", () => {
    refusal = new ApiError(409, "This organization still holds the project \"Billing\", so the organization was not deleted.", "ORG_NOT_EMPTY");
    card();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    const failure = within(screen.getByRole("dialog")).getByTestId("panel-failure");
    expect(failure.textContent).toContain("The organization was not deleted");
    expect(failure.textContent).toContain("still holds the project");
    expect(toast).not.toHaveBeenCalled();
  });

  it("tells a refused rename inside its panel, under the name field, and in no toast", () => {
    refusal = new ApiError(400, "An organization's name is at most 200 characters, so it was not saved.", "BAD_REQUEST");
    card();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "x".repeat(201) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const failure = within(screen.getByRole("dialog")).getByTestId("panel-failure");
    expect(failure.textContent).toContain("The organization was not renamed");
    expect(failure.textContent).toContain("at most 200 characters");
    expect(toast).not.toHaveBeenCalled();
  });
});
