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
        { userId: "me", displayName: null, email: "me@example.com", addedAt: "2026-10-01T09:00:00.000Z" },
        { userId: "u2", displayName: null, email: "mai@example.com", addedAt: "2026-10-02T09:00:00.000Z" },
      ],
      handles: [],
    };
    pickTheProject();
    const labels = [...document.querySelectorAll("[data-person-label]")].map((l) => l.textContent);
    expect(labels).toEqual(["You", "Another member"]);
    expect(screen.queryByText("me@example.com")).toBeNull();
  });

  // ISS-1229 r28, judge-80: the people offered followed address order, so an unnamed person joined
  // last could lead the list and a named one trail it.
  it("offers the named by name, then the unnamed by when each joined", () => {
    candidates = {
      people: [
        { userId: "u-late", displayName: null, email: "a-late@example.com", addedAt: "2026-10-03T09:00:00.000Z" },
        { userId: "u-zed", displayName: "Zed", email: "b-zed@example.com", addedAt: "2026-10-04T09:00:00.000Z" },
        { userId: "u-early", displayName: null, email: "c-early@example.com", addedAt: "2026-10-01T09:00:00.000Z" },
        { userId: "u-an", displayName: "An", email: "d-an@example.com", addedAt: "2026-10-05T09:00:00.000Z" },
      ],
      handles: [],
    };
    pickTheProject();
    const offered = [...document.querySelectorAll("[data-person-detail]")].map((l) => l.textContent);
    expect(offered).toEqual(["d-an@example.com", "b-zed@example.com", "c-early@example.com", "a-late@example.com"]);
    const labels = [...document.querySelectorAll("[data-person-label]")].map((l) => l.textContent);
    expect(labels[0]).toBe("You");
  });
});
