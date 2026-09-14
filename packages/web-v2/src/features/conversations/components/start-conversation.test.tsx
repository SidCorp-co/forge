// @vitest-environment jsdom
//
// ISS-1011 review F4 — a room is not opened until its consequences are on screen.
//
// Opening a room with a second agent is a scope decision: it decides what the
// room can see, whether it can be spoken in at all, and who can read it. The
// screen that takes that decision showed none of it, and the alternative to a
// confirmation step here is a person finding out from a composer that refuses.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

// cm:why jsdom implements no scrolling, and the combobox scrolls its active option into view as it opens — without this stub the picker throws before anything here is asserted
Element.prototype.scrollIntoView = vi.fn();

const open = vi.fn();
const candidatesForProject = vi.fn();

vi.mock("../api", () => ({
  conversationsApi: {
    open: (...a: unknown[]) => open(...a),
    candidates: (...a: unknown[]) => candidatesForProject(...a),
    candidatesForProject: (...a: unknown[]) => candidatesForProject(...a),
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({
    projects: [
      { id: "p1", name: "Alpha", slug: "alpha" },
      { id: "p2", name: "Beta", slug: "beta" },
    ],
  }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { StartConversation } = await import("./start-conversation");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  open.mockResolvedValue({ id: "c1" });
  candidatesForProject.mockResolvedValue({
    people: [],
    handles: [
      { userId: "ua2", handle: "beta", project: { id: "p2", name: "Beta", slug: "beta" }, losesReaders: [] },
      { userId: null, handle: "gamma", project: { id: "p9", name: "Gamma", slug: "gamma" }, losesReaders: [] },
    ],
  });
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StartConversation onStarted={() => undefined} />
    </QueryClientProvider>,
  );
}

// cm:why the project picker is the design system's combobox rather than a native select, so it is driven the way a person drives it — open the listbox, click the option
const pickAlpha = () => {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
};

describe("starting a room", () => {
  it("opens nothing until the consequences have been shown and accepted", async () => {
    mount();
    pickAlpha();
    fireEvent.click(await screen.findByRole("button", { name: "Start the room" }));
    expect(await screen.findByTestId("start-confirmation")).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open the room" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });

  it("says what the room will be about, and that nobody chose it", async () => {
    mount();
    pickAlpha();
    fireEvent.click(await screen.findByRole("button", { name: "Start the room" }));
    const shown = await screen.findByTestId("start-confirmation");
    expect(shown.textContent).toContain("Alpha");
    expect(shown.textContent).toMatch(/nobody chooses it/i);
  });

  // cm:guard the base project counts as an agent the person never ticked: the room opens with its own handle, so one ticked agent from a second project makes TWO, and a confirmation counting only the boxes would call it private and name one project.
  it("counts the room's own agent, so a second project reads as two projects and a shared room", async () => {
    mount();
    pickAlpha();
    fireEvent.click(await screen.findByRole("checkbox", { name: /beta/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start the room" }));
    const shown = await screen.findByTestId("start-confirmation");
    expect(shown.textContent).toContain("Alpha and Beta");
    expect(shown.textContent).toMatch(/answered under exactly one project/i);
    expect(shown.textContent).toMatch(/not only the people listed here/i);
  });

  // cm:guard core excludes the handle the room opens with BY IDENTITY, so anything still offered for that project is a different agent — a second handle in the room, and therefore a shared room, while the scope stays the one project. The two claims are counted on different keys for exactly this case.
  it("counts a second agent of the room's own project as a second handle, not a second project", async () => {
    candidatesForProject.mockResolvedValue({
      people: [],
      handles: [
        {
          userId: "ua1-second",
          handle: "alpha-two",
          project: { id: "p1", name: "Alpha", slug: "alpha" },
          losesReaders: [],
        },
      ],
    });
    mount();
    pickAlpha();
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-two/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start the room" }));
    const shown = await screen.findByTestId("start-confirmation");
    expect(shown.textContent).toMatch(/not only the people listed here/i);
    expect(shown.textContent).toContain("Alpha");
    expect(shown.textContent).not.toContain("Beta");
    expect(shown.textContent).not.toMatch(/answered under exactly one project/i);
  });

  it("goes back to the choosing without opening anything", async () => {
    mount();
    pickAlpha();
    fireEvent.click(await screen.findByRole("button", { name: "Start the room" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("start-confirmation")).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  // cm:guard an agent whose project has never been talked to is offered with a null id, and the room must open asking for the project alone — core mints the handle inside the same transaction that opens the room.
  it("asks for an unminted project's agent without an agent id", async () => {
    mount();
    pickAlpha();
    fireEvent.click(await screen.findByRole("checkbox", { name: /gamma/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start the room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open the room" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      projectId: "p1",
      handles: [{ userId: null, projectId: "p9" }],
    });
  });
});
