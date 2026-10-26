// @vitest-environment jsdom
//
// ISS-1421 r29, judge-119 on 313 and 319: Epodsystem's Add storefront was drawn for every reader, so
// a plain member or a viewer typed a label and a crmk_ key into a form whose submit core refused 403,
// and the filled form stood after the refusal still offering the same submit.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BindingListResponse, ProjectIntegrationActs } from "@forge/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { ALL_MAY } from "../../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const MEMBER_MAY: ProjectIntegrationActs = {
  ...ALL_MAY,
  connect: false,
  grantBoxAgents: false,
  changeProjectSettings: false,
};

/** The project's list as core last answered it; a write's re-read replaces it and redraws its readers. */
const listRead = {
  answer: { bindings: [], items: [], may: ALL_MAY } as BindingListResponse,
  listeners: new Set<() => void>(),
};
function listAnswers(may: ProjectIntegrationActs) {
  listRead.answer = { ...listRead.answer, may };
  for (const l of listRead.listeners) l();
}

const create = vi.fn();

vi.mock("../../hooks", async () => {
  const React = await import("react");
  const useList = () => {
    React.useSyncExternalStore(
      (l) => {
        listRead.listeners.add(l);
        return () => listRead.listeners.delete(l);
      },
      () => listRead.answer,
    );
    return { data: listRead.answer, isLoading: false, refetch: vi.fn() };
  };
  return {
    useIntegrationsList: useList,
    useProjectIntegrationActs: () => useList().data.may,
    useCreateProviderIntegration: () => ({ mutateAsync: create, isPending: false }),
    useUpdateProviderIntegration: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useTestIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock("../../components/connection-owner-field", () => ({ ConnectionOwnerField: () => null }));

const { EpodsystemSection } = await import("./section");

beforeEach(() => {
  create.mockReset();
  listRead.answer = { bindings: [], items: [], may: ALL_MAY };
});
afterEach(cleanup);

describe("Epodsystem's Add storefront", () => {
  it.each([
    ["a plain member", MEMBER_MAY],
    ["a viewer", MEMBER_MAY],
  ])("is not offered to %s, who reads who may add one and has nowhere to type a key", (_who, may) => {
    listRead.answer = { ...listRead.answer, may };
    render(<EpodsystemSection projectId={PROJECT} />);
    expect(screen.queryByRole("button", { name: "Add storefront" })).toBeNull();
    expect(screen.queryByPlaceholderText(/crmk_/)).toBeNull();
    expect(
      screen.getByText("Only an admin of this project can add a storefront to this project."),
    ).toBeInTheDocument();
  });

  it("is offered to a reader who may connect, and opens the form", () => {
    render(<EpodsystemSection projectId={PROJECT} />);
    fireEvent.click(screen.getByRole("button", { name: "Add storefront" }));
    expect(screen.getByPlaceholderText(/crmk_/)).toBeEnabled();
    expect(screen.queryByText(/can add a storefront/)).toBeNull();
  });

  it("is withdrawn, the typed key with it, once a refused add's re-read says the reader may not", async () => {
    create.mockImplementation(async () => {
      // The hook's refusal re-reads the list (`refusedForTheReader`), which now answers for a member.
      listAnswers(MEMBER_MAY);
      throw new ApiError(
        403,
        "You are a member of this project, so you cannot connect an integration to it.",
        "FORBIDDEN",
      );
    });
    render(<EpodsystemSection projectId={PROJECT} />);
    fireEvent.click(screen.getByRole("button", { name: "Add storefront" }));
    fireEvent.change(screen.getByPlaceholderText(/crmk_/), {
      target: { value: "crmk_made_up_key_123" },
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Add storefront" }).at(-1) as HTMLElement);
    });
    expect(screen.queryByPlaceholderText(/crmk_/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add storefront" })).toBeNull();
    expect(
      screen.getByText("Only an admin of this project can add a storefront to this project."),
    ).toBeInTheDocument();
  });
});
