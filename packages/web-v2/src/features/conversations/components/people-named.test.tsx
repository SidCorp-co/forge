// @vitest-environment jsdom
//
// ISS-1229 r21, the coordinator's amended ruling: the people a room could take in are offered by
// their display name, else "Another member", with their address as secondary text — a picker is
// where a member chooses an identity, so two members with no display name must be told apart.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddPersonDialog } from "./add-person-dialog";
import { StartConversation } from "./start-conversation";

const people = [
  { userId: "u1", displayName: "Mai Tran", email: "mai.tran@example.com" },
  { userId: "u2", displayName: null, email: "lan.pham@example.com" },
  { userId: "u3", displayName: "kim@example.org", email: "kim@example.org" },
];

Element.prototype.scrollIntoView = vi.fn();
vi.mock("../hooks", () => ({
  useConversationCandidates: () => ({ isLoading: false, isError: false, data: { people, handles: [] } }),
  useAddPerson: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
  useProjectCandidates: () => ({ isLoading: false, isError: false, data: { people, handles: [] } }),
  useOpenConversation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects: [{ id: "p1", name: "Billing", slug: "billing" }] }),
}));

afterEach(cleanup);

/** Each offered person as "<name> · <address>", read off the rows the picker shows. */
const offered = (rows: HTMLElement[]) =>
  rows.map((row) => [row.querySelector("[data-person-label]"), row.querySelector("[data-person-detail]")]
    .map((n) => n?.textContent ?? "")
    .join(" · "));

describe("adding a person to a room", () => {
  it("offers each candidate by name, else Another member, beside their own address", () => {
    render(<AddPersonDialog conversationId="c1" room={{ shape: "group" }} open onClose={() => {}} />);
    expect(offered(screen.getAllByRole("button").filter((b) => b.querySelector("[data-person-label]")))).toEqual([
      "Mai Tran · mai.tran@example.com",
      "Another member · lan.pham@example.com",
      "Another member · kim@example.org",
    ]);
  });

  it("confirms the pick by name and address", () => {
    render(<AddPersonDialog conversationId="c1" room={{ shape: "group" }} open onClose={() => {}} />);
    fireEvent.click(screen.getByText("kim@example.org"));
    expect(screen.getByText("Add Another member")).toBeTruthy();
    expect(screen.getByText("kim@example.org")).toBeTruthy();
    expect(screen.queryByText("lan.pham@example.com")).toBeNull();
  });
});

describe("starting a conversation", () => {
  it("offers each person by name, else Another member, beside their own address", () => {
    render(<StartConversation onStarted={() => {}} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Billing" }));
    expect(offered(screen.getAllByRole("checkbox").map((c) => c.closest("label") as HTMLElement))).toEqual([
      "Mai Tran · mai.tran@example.com",
      "Another member · lan.pham@example.com",
      "Another member · kim@example.org",
    ]);
  });
});
