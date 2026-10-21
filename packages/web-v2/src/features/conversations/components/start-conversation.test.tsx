// @vitest-environment jsdom
//
// ISS-1229 r25, judge-72: the room starter listed the reader themself among the people to add, as a
// second "Another member" beside the one who really was. The opener is in the room by opening it, so
// they are listed once, as "You", and never offered to themself.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationCandidates } from "../types";

let candidates: ConversationCandidates = { people: [], handles: [] };

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects: [{ id: "p1", name: "Billing", slug: "billing" }] }),
}));
vi.mock("../hooks", () => ({
  useProjectCandidates: () => ({ data: candidates, isLoading: false, isError: false }),
  useOpenConversation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

const { StartConversation } = await import("./start-conversation");

afterEach(cleanup);
// jsdom lays nothing out, and the project picker scrolls its chosen option into view.
Element.prototype.scrollIntoView = () => {};

function pickTheProject() {
  render(<StartConversation onStarted={vi.fn()} />);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "Billing" }));
}

describe("the people a room starts with", () => {
  it('lists the reader once, as "You", and another unnamed member as another member', () => {
    candidates = {
      people: [
        { userId: "me", displayName: null, email: "me@example.com" },
        { userId: "u2", displayName: null, email: "mai@example.com" },
      ],
      handles: [],
    };
    pickTheProject();
    const labels = [...document.querySelectorAll("[data-person-label]")].map((l) => l.textContent);
    expect(labels).toEqual(["You", "Another member"]);
    expect(screen.queryByText("me@example.com")).toBeNull();
  });
});
