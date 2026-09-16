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

  // cm:guard the defect this file exists for: the form used to send `role: "service"`
  // whatever the operator meant, so a storefront this project publishes to was never a
  // declared release target and the release gate silently had nothing to send to.
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

  // cm:guard the refusal is the form's and it NAMES the remedy — the database refuses a
  // stageless deploy binding by constraint, and a bare 400 names neither the field nor
  // what a valid value looks like.
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

  // cm:guard switching back to `service` CLEARS the stages rather than merely hiding the
  // control. A hidden value that still submits is how a service binding reaches the
  // server carrying a stage, which the database refuses with a 500 the form caused.
  // cm:guard hiding the stage controls is NOT clearing them. Choose Live, switch to Service,
  // switch back to Deploy, and a form that only hid them submits a stage the operator never
  // re-chose — a declaration made by the form rather than by the person. The round trip is
  // what makes this assertion able to go red; asserting on the Service payload alone cannot,
  // because `stages` is spread only under `deploy` either way.
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
