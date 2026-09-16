// @vitest-environment jsdom
//
// ISS-1046 — "Add storefront" submitted `role: "service"` with no stage and no
// way to say otherwise, while the copy around it promised publishing through
// the release pipeline. A storefront connected here was therefore never a
// declared release target, and nothing on the screen said so. What a binding is
// FOR is DECLARED by the person; these assertions are on the declaration
// actually reaching the mutation.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";
import { EpodsystemSection } from "./epodsystem-section";

expect.extend(matchers);
afterEach(cleanup);

const createMutate = vi.fn();
const listItems = vi.fn<() => IntegrationSummary[]>();

vi.mock("../hooks", () => ({
  useIntegrationsList: () => ({
    data: { items: listItems() },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateProviderIntegration: () => ({ mutateAsync: createMutate, isPending: false }),
  useUpdateProviderIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProviderIntegration: () => ({ mutate: vi.fn(), isPending: false }),
  useTestIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
}));

vi.mock("./connection-owner-field", () => ({ ConnectionOwnerField: () => null }));
vi.mock("./integration-enabled-control", () => ({ IntegrationEnabledControl: () => null }));

// The design system's `Select` is a custom listbox, not a native <select>: the
// trigger is a `combobox` and the choices are `option`s that appear once it is
// clicked. jsdom has no `scrollIntoView`, which the listbox calls on open.
Element.prototype.scrollIntoView = vi.fn();

function pick(optionText: string | RegExp) {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: optionText }));
}

function openAddForm() {
  render(<EpodsystemSection projectId="proj-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Add storefront" }));
}

function typeKey(key = "crmk_abcdefgh") {
  fireEvent.change(screen.getByPlaceholderText("crmk_…"), { target: { value: key } });
}

function submit() {
  const buttons = screen.getAllByRole("button", { name: "Add storefront" });
  fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  listItems.mockReturnValue([]);
  createMutate.mockResolvedValue(undefined);
});

describe("AddEpodsystemForm — the declaration the operator makes", () => {
  it("offers the role choice rather than deciding it", () => {
    openAddForm();

    expect(screen.getByText("What is it for")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox"));
    expect(
      screen.getByRole("option", { name: /Deploy target/ }),
    ).toBeInTheDocument();
  });

  it("submits a deploy role with the stages chosen, not a hardcoded service", async () => {
    openAddForm();
    typeKey();
    pick(/Deploy target/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Preview/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Live/ }));
    submit();

    await vi.waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]?.[0]).toMatchObject({
      provider: "epodsystem",
      role: "deploy",
      stages: ["preview", "live"],
    });
  });

  it("submits a service role carrying no stages at all", async () => {
    openAddForm();
    typeKey();
    submit();

    await vi.waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const body = createMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.role).toBe("service");
    expect(body).not.toHaveProperty("stages");
  });

  it("refuses a stageless deploy by name, before the round trip", async () => {
    openAddForm();
    typeKey();
    pick(/Deploy target/);
    submit();

    expect(
      await screen.findByText(/Choose at least one stage/),
    ).toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("clears the stages it hides, so a stage cannot survive a trip through service", async () => {
    openAddForm();
    typeKey();
    pick(/Deploy target/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Live/ }));
    pick(/Service/);
    expect(screen.queryByRole("checkbox", { name: /Live/ })).toBeNull();
    pick(/Deploy target/);

    submit();
    // No stage is chosen any more, so the form refuses by name rather than resubmitting `live`.
    await vi.waitFor(() =>
      expect(screen.getByText(/Choose at least one stage/)).toBeInTheDocument(),
    );
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("sends no `stages` key at all for a service binding", async () => {
    openAddForm();
    typeKey();

    submit();
    await vi.waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const body = createMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.role).toBe("service");
    expect(body).not.toHaveProperty("stages");
  });
});
