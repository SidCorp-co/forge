// @vitest-environment jsdom
//
// ISS-1229 r25 after-shot: at 390 wide each member's row gave the lens chips, role picker and remove
// control their width and left one or two characters of who the member is.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgMembersCard } from "./org-members-card";

const idle = { mutate: vi.fn(), isPending: false, isError: false };
vi.mock("../hooks", () => ({
  useOrgMembers: () => ({
    isLoading: false,
    isError: false,
    data: [
      { userId: "me", email: "lan@example.com", role: "owner", lenses: ["technical"] },
      { userId: "u2", email: "a-long-address-for-a-member@example.com", role: "member", lenses: [] },
    ],
  }),
  useOrgProjects: () => ({ isLoading: false, isError: false, data: [] }),
  useOrgInvitations: () => ({ isLoading: false, isError: false, data: [] }),
  useAddOrgMember: () => idle,
  useDeleteOrg: () => idle,
  useRemoveOrgMember: () => idle,
  useRenameOrg: () => idle,
  useRevokeOrgInvitation: () => idle,
  useUpdateOrgMemberLenses: () => idle,
  useUpdateOrgMemberRole: () => idle,
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

afterEach(cleanup);

describe("a member's row on the organization page", () => {
  it("wraps its controls under the member rather than squeezing who the member is", () => {
    render(<OrgMembersCard org={{ id: "o1", name: "Northwind", slug: "northwind", role: "owner" } as never} onDeleted={() => {}} />);
    const rows = screen.getAllByTestId("org-member-row");
    expect(rows).toHaveLength(2);
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
});
