// @vitest-environment jsdom
//
// The save REPLACES `agentConfig.plugins` whole, so the two things that matter
// are that the draft always starts from the fetched list and that it is always
// sent complete. Everything else here is the states contract: a plugin list is
// empty on a fresh project, and a removal is destructive for every device
// serving it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import { PluginsSection } from "./components/plugins-section";

expect.extend(matchers);
afterEach(cleanup);

const mutate = vi.fn();
const projectQuery = vi.fn();

vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return { ...actual, useUpdatePlugins: () => ({ mutate, isPending: false }) };
});
vi.mock("@/features/projects/hooks", () => ({ useProject: () => projectQuery() }));

const PLUGIN = {
  marketplace: "SidCorp-co/forge-plugin",
  name: "forge",
  pinnedRef: "054d7575",
  autoUpdate: false,
};

function renderWith(agentConfig: unknown, canEdit = true) {
  projectQuery.mockReturnValue({
    data: { agentConfig },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <PluginsSection projectId="p1" canEdit={canEdit} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole("button", { name: /save plugins/i });

beforeEach(() => {
  mutate.mockClear();
});

describe("PluginsSection", () => {
  it("renders a skeleton while the project loads", () => {
    projectQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <PluginsSection projectId="p1" canEdit />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders a retryable error rather than an empty list", () => {
    projectQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      refetch: vi.fn(),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <PluginsSection projectId="p1" canEdit />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  // cm:guard the empty state must name the CONSEQUENCE, not just the absence: a project with no plugin dispatches a driver that is told to use a skill it does not have, and the session fails with no operator anywhere near it.
  it("shows a first-run empty state naming what a missing plugin costs", () => {
    renderWith({});

    expect(screen.getByText(/No plugins yet/i)).toBeInTheDocument();
    expect(screen.getByText(/skill it does not have/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add a plugin/i })).toBeInTheDocument();
  });

  it("seeds the draft from the stored list", () => {
    renderWith({ plugins: [PLUGIN] });

    expect(screen.getByDisplayValue("SidCorp-co/forge-plugin")).toBeInTheDocument();
    expect(screen.getByDisplayValue("054d7575")).toBeInTheDocument();
    expect(screen.getByText("pinned")).toBeInTheDocument();
  });

  // cm:guard the save sends the WHOLE list. A partial send is not a smaller edit against this endpoint, it is a deletion of everything omitted — so an edit to one row must still carry the row beside it.
  it("sends every row, not only the edited one", () => {
    renderWith({ plugins: [PLUGIN, { ...PLUGIN, name: "other", pinnedRef: null }] });

    fireEvent.change(screen.getByDisplayValue("054d7575"), { target: { value: "abcdef1" } });
    fireEvent.click(saveButton());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual([
      { ...PLUGIN, pinnedRef: "abcdef1" },
      { ...PLUGIN, name: "other", pinnedRef: null, autoUpdate: false },
    ]);
  });

  it("keeps Save disabled until something actually changed", () => {
    renderWith({ plugins: [PLUGIN] });

    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("forge"), { target: { value: "forge-two" } });
    expect(saveButton()).toBeEnabled();
  });

  // cm:guard the same rules the server enforces, stated at the field rather than returned as a 400. A name that is not kebab-case or a ref that is not a SHA reaches a device that then fails to install, so the form must refuse before the write.
  it("blocks the save and says why on an invalid row", () => {
    renderWith({ plugins: [PLUGIN] });

    fireEvent.change(screen.getByDisplayValue("forge"), { target: { value: "Forge Plugin" } });
    // cm:guard TWO on purpose — beside the row that is wrong, and in the summary banner next to the disabled Save. A reader who scrolled to the button has to be told why it is dead without hunting for the row.
    expect(screen.getAllByText("Name must be kebab-case.")).toHaveLength(2);
    expect(saveButton()).toBeDisabled();

    fireEvent.change(screen.getByDisplayValue("Forge Plugin"), { target: { value: "forge" } });
    fireEvent.change(screen.getByDisplayValue("054d7575"), { target: { value: "zzz" } });
    expect(screen.getAllByText("Pinned SHA must be 7–40 hex characters.")).toHaveLength(2);
    expect(saveButton()).toBeDisabled();
  });

  // cm:guard removing a plugin drops it from every device serving this project on their next poll — destructive and not obviously so from the button, which is why it confirms first.
  it("confirms before removing rather than removing on the click", () => {
    renderWith({ plugins: [PLUGIN] });

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    expect(screen.getByText(/Remove this plugin\?/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("SidCorp-co/forge-plugin")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /^remove$/i }).at(-1) as HTMLElement);
    expect(screen.queryByDisplayValue("SidCorp-co/forge-plugin")).toBeNull();
  });

  it("is read-only without edit rights — no save, no remove, disabled fields", () => {
    renderWith({ plugins: [PLUGIN] }, false);

    expect(screen.queryByRole("button", { name: /save plugins/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(screen.getByDisplayValue("forge")).toBeDisabled();
  });
});
