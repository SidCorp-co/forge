// @vitest-environment jsdom
//
// ISS-1421 r35, judge-141: a drawer opened from one Epodsystem storefront row offered Add storefront,
// so adding a storefront lived inside another storefront's drawer. A row's drawer is about that
// storefront alone; Add storefront sits on the tab beside the provider's rows, for a reader who may.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectIntegrationActs } from "@forge/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCard } from "../types";
import { ALL_MAY } from "../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const MEMBER_MAY: ProjectIntegrationActs = { ...ALL_MAY, connect: false };

const state = { cards: [] as StatusCard[], may: ALL_MAY, listFails: false };
const refetchList = vi.fn();
/** What the drawer was last drawn with. */
const drawn: Array<{ card: StatusCard | null; adding?: boolean }> = [];

vi.mock("../hooks", () => ({
  useIntegrationsStatus: () => ({
    data: { cards: state.cards },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useIntegrationsList: () =>
    state.listFails
      ? { data: undefined, isError: true, error: new Error("The server did not answer."), refetch: refetchList }
      : { data: { items: [], bindings: [], may: state.may }, isError: false, error: null, refetch: refetchList },
}));
vi.mock("./connection-detail-drawer", () => ({
  ConnectionDetailDrawer: (props: { card: StatusCard | null; adding?: boolean }) => {
    drawn.push({ card: props.card, adding: props.adding });
    return null;
  },
}));
vi.mock("./mcp-servers-panel", () => ({ McpServersPanel: () => null }));

const { ProjectIntegrationsPanel } = await import("./project-integrations-panel");

const storefront: StatusCard = {
  key: "epodsystem",
  label: "Epodsystem",
  status: "connected",
  detail: "The last check passed.",
  lastSyncAt: null,
  configured: true,
  meta: { bindingId: "b-1", storeName: "Store A", capabilities: { multiBinding: true } },
};

beforeEach(() => {
  state.cards = [storefront];
  state.may = ALL_MAY;
  state.listFails = false;
  refetchList.mockReset();
  drawn.length = 0;
});
afterEach(cleanup);

describe("Add storefront on a project's Integrations tab", () => {
  it("sits beside the storefront rows and opens the drawer on no storefront, adding one", () => {
    render(<ProjectIntegrationsPanel projectId={PROJECT} />);
    expect(screen.getByRole("button", { name: /Manage Epodsystem .*Store A/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add storefront" }));
    const last = drawn.at(-1);
    expect(last?.adding).toBe(true);
    expect(last?.card?.key).toBe("epodsystem");
    expect(last?.card?.meta?.bindingId).toBeUndefined();
  });

  it("opening a storefront's row opens that storefront, not the add form", () => {
    render(<ProjectIntegrationsPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByRole("button", { name: /Manage Epodsystem .*Store A/ }));
    const last = drawn.at(-1);
    expect(last?.adding).toBe(false);
    expect(last?.card?.meta?.bindingId).toBe("b-1");
  });

  it("is not offered to a reader who may not connect one", () => {
    state.may = MEMBER_MAY;
    render(<ProjectIntegrationsPanel projectId={PROJECT} />);
    expect(screen.queryByRole("button", { name: "Add storefront" })).toBeNull();
  });

  // Review F2: the list this button is offered by could fail to read, and the button went with no word.
  it("where the list it is offered by cannot be read, the tab says so and offers Retry", () => {
    state.listFails = true;
    render(<ProjectIntegrationsPanel projectId={PROJECT} />);
    expect(screen.queryByRole("button", { name: "Add storefront" })).toBeNull();
    expect(screen.getByText(/integration list could not be read.*nothing can be added here/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchList).toHaveBeenCalledTimes(1);
  });

  it("is not on the tab before the first storefront, whose row is where it is connected", () => {
    state.cards = [{ ...storefront, status: "not_configured", configured: false, meta: {} }];
    render(<ProjectIntegrationsPanel projectId={PROJECT} />);
    expect(screen.queryByRole("button", { name: "Add storefront" })).toBeNull();
  });
});
