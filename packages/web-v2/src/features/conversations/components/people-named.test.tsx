// @vitest-environment jsdom
//
// ISS-1229 r21: the people a room could take in are named as everywhere a member reads them — the
// display name, else "Another member" — and no address is shown beside them.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddPersonDialog } from "./add-person-dialog";

const people = [
  { userId: "u1", displayName: "Mai Tran", email: "mai.tran@example.com" },
  { userId: "u2", displayName: null, email: "lan.pham@example.com" },
  { userId: "u3", displayName: "lan@example.org", email: "lan@example.org" },
];

vi.mock("../hooks", () => ({
  useConversationCandidates: () => ({ isLoading: false, isError: false, data: { people, handles: [] } }),
  useAddPerson: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
}));

afterEach(cleanup);

describe("adding a person to a room", () => {
  it("names each candidate by display name, else Another member, and shows no address", () => {
    const { baseElement } = render(
      <AddPersonDialog conversationId="c1" room={{ shape: "group" }} open onClose={() => {}} />,
    );
    expect(screen.getByText("Mai Tran")).toBeTruthy();
    expect(screen.getAllByText("Another member")).toHaveLength(2);
    expect(baseElement.textContent).not.toMatch(/@|lan\.pham|mai\.tran/);
  });

  it("confirms the pick by name, with no address", () => {
    const { baseElement } = render(
      <AddPersonDialog conversationId="c1" room={{ shape: "group" }} open onClose={() => {}} />,
    );
    fireEvent.click(screen.getAllByText("Another member")[0] as HTMLElement);
    expect(screen.getByText("Add Another member")).toBeTruthy();
    expect(baseElement.textContent).not.toMatch(/@|lan\.pham/);
  });
});
