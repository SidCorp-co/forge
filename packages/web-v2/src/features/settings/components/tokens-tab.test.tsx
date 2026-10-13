// @vitest-environment jsdom
//
// ISS-1255 — the grant is the minter's choice, and the form makes none for
// them. What is asserted below is that choice: a fresh form holds none, it
// will not submit until one is made, each choice reaches the door as the
// value the door accepts, and the list afterwards says which of the three
// grants each token carries.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatToken } from "../types";

expect.extend(matchers);
Element.prototype.scrollIntoView = vi.fn();

const MENU = {
  permissions: ["issues:read", "issues:write", "schedules:read", "schedules:write"],
  full: "*",
};

function aToken(over: Partial<PatToken>): PatToken {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "a token",
    prefix: "forge_pat_x",
    scopes: ["read"],
    projectIds: null,
    permissions: null,
    grant: "legacy",
    boundProjectId: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    ...over,
  };
}

let tokens: PatToken[] = [];
const createMutate = vi.fn();
const revokeMutate = vi.fn();

vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { hasPassword: true, oauthProviders: [] } }),
}));
vi.mock("../hooks", () => ({
  useTokens: () => ({
    data: { tokens, menu: MENU },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useCreateToken: () => ({ mutate: createMutate, isPending: false }),
  useRevokeToken: () => ({ mutate: revokeMutate, isPending: false }),
  useReauth: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { TokensTab } from "./tokens-tab";

const nameField = () => screen.getByPlaceholderText("e.g. CI deploy token");
const createButton = () => screen.getByRole("button", { name: "Create token" });

beforeEach(() => {
  tokens = [];
  createMutate.mockClear();
  revokeMutate.mockClear();
});
afterEach(cleanup);

describe("TokensTab — the grant is the minter's choice", () => {
  it("chooses nothing on a fresh form", () => {
    render(<TokensTab />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false");
    }
  });

  it("sends no create when a name is filled in and no grant chosen", () => {
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(createButton());
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Choose what this token may reach.")).toBeInTheDocument();
  });

  it("sends the full-access value when full access is chosen", () => {
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]?.[0]).toMatchObject({ permissions: ["*"] });
  });

  it("refuses to submit a named choice with nothing ticked", () => {
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /permissions I pick/ }));
    fireEvent.click(createButton());
    expect(createMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText("Pick at least one permission, or choose full access."),
    ).toBeInTheDocument();
  });

  it("sends exactly the names ticked", () => {
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /permissions I pick/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "issues:read" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "schedules:write" }));
    fireEvent.click(createButton());
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]?.[0]).toMatchObject({
      permissions: ["issues:read", "schedules:write"],
    });
  });

  it("offers the permissions the door accepts, and not the full-access value", () => {
    render(<TokensTab />);
    fireEvent.click(screen.getByRole("radio", { name: /permissions I pick/ }));
    for (const permission of MENU.permissions) {
      expect(screen.getByRole("checkbox", { name: permission })).toBeInTheDocument();
    }
    expect(screen.queryByRole("checkbox", { name: MENU.full })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "knowledge:read" })).toBeNull();
  });
});

describe("TokensTab — what the list says each token may reach", () => {
  it("reads the three grants differently", () => {
    tokens = [
      aToken({ id: "1", name: "chosen-full", permissions: ["*"], grant: "full" }),
      aToken({ id: "2", name: "narrowed", permissions: ["issues:read"], grant: "named" }),
      aToken({ id: "3", name: "from-before", permissions: null, grant: "legacy" }),
    ];
    render(<TokensTab />);
    expect(screen.getAllByText("Full access").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 permission").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Legacy — full access, never stated").length,
    ).toBeGreaterThan(0);
  });
});

// ISS-1166 — the screen answers "what can still reach my account?" first. The fixture is the account the
// audit measured: 43 tokens, 41 of them revoked, 38 of those the assistant's, and two live walk tokens.
describe("TokensTab — what still has access comes first", () => {
  const LIVE = [
    aToken({ id: "l1", name: "iss974-walk-2", createdAt: "2026-09-10T00:00:00.000Z" }),
    aToken({ id: "l2", name: "iss974-walk-admin", createdAt: "2026-09-11T00:00:00.000Z" }),
  ];
  const OWN_ENDED = [
    aToken({ id: "e1", name: "old-ci", revokedAt: "2026-09-02T00:00:00.000Z" }),
    aToken({ id: "e2", name: "old-bot", revokedAt: "2026-09-03T00:00:00.000Z" }),
    aToken({ id: "e3", name: "lapsed", expiresAt: "2026-09-04T00:00:00.000Z" }),
  ];
  const CHAT = Array.from({ length: 38 }, (_, i) =>
    aToken({
      id: `c${i}`,
      name: `chat turn 2026-09-17T09:57:56.421Z ${i.toString(16).padStart(8, "0")}`,
      revokedAt: "2026-09-17T10:00:00.000Z",
    }),
  );
  const rowNames = (label: string) =>
    within(screen.getByRole("table", { name: label }))
      .getAllByRole("row")
      .slice(1)
      .map((tr) => within(tr).getAllByRole("cell")[0]?.querySelector(".font-medium")?.textContent);

  beforeEach(() => {
    tokens = [...CHAT, ...OWN_ENDED, ...LIVE];
  });

  it("states how many tokens can reach the account, in words, above the list", () => {
    render(<TokensTab />);
    expect(screen.getByRole("status")).toHaveTextContent("2 tokens can reach your account.");
  });

  it("lists the live tokens and none of the others, with the list above the create form", () => {
    render(<TokensTab />);
    expect(rowNames("Tokens that can reach your account").sort()).toEqual(["iss974-walk-2", "iss974-walk-admin"]);
    expect(screen.queryByText("old-ci")).toBeNull();
    const list = screen.getByRole("table", { name: "Tokens that can reach your account" });
    const form = screen.getByText("Create a token");
    expect(list.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts the ended tokens behind one closed line that carries their number, and not the assistant's", () => {
    render(<TokensTab />);
    const line = screen.getByRole("button", { name: /3 tokens no longer reach your account/ });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "Tokens that no longer reach your account" })).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(rowNames("Tokens that no longer reach your account").sort()).toEqual(["lapsed", "old-bot", "old-ci"]);
  });

  it("says revoked or expired, with the date, on an ended row, and gives it no control at all", () => {
    render(<TokensTab />);
    fireEvent.click(screen.getByRole("button", { name: /no longer reach your account/ }));
    const ended = screen.getByRole("table", { name: "Tokens that no longer reach your account" });
    expect(within(ended).getAllByText(/^revoked /)).toHaveLength(2);
    expect(within(ended).getByText(/^expired /)).toBeInTheDocument();
    expect(within(ended).queryAllByRole("button", { name: /Revoke/ })).toHaveLength(0);
  });

  it("gives a live row an enabled Revoke that revokes that token, and no live row a disabled one", () => {
    render(<TokensTab />);
    const live = screen.getByRole("table", { name: "Tokens that can reach your account" });
    const buttons = within(live)
      .getAllByRole("button")
      .filter((b) => /^Revoke/.test(b.getAttribute("aria-label") ?? ""));
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toBeEnabled();
    fireEvent.click(within(live).getByRole("button", { name: "Revoke, iss974-walk-admin" }));
    expect(revokeMutate).toHaveBeenCalledWith("l2");
  });

  it("never makes a row of an assistant chat-turn credential, and says how many there are", () => {
    render(<TokensTab />);
    expect(screen.queryAllByText(/^chat turn /)).toHaveLength(0);
    expect(screen.getByText(/38 credentials made by the assistant for single chat turns, none are live\./)).toBeInTheDocument();
    expect(screen.getByText(/revoked when its turn ends, and otherwise expires within ten minutes/)).toBeInTheDocument();
  });

  it("counts a live chat-turn credential in the statement and the summary, still without a row", () => {
    tokens = [aToken({ id: "c-live", name: "chat turn 2026-10-14T00:00:00.000Z 0000000a" }), ...LIVE];
    render(<TokensTab />);
    expect(screen.getByRole("status")).toHaveTextContent("3 tokens can reach your account.");
    expect(screen.getByText(/1 credential made by the assistant.*1 is live/)).toBeInTheDocument();
    expect(rowNames("Tokens that can reach your account")).toHaveLength(2);
  });

  it("says no token can reach the account when every one has ended, and still offers the ended ones", () => {
    tokens = OWN_ENDED;
    render(<TokensTab />);
    expect(screen.getByRole("status")).toHaveTextContent("No token can reach your account.");
    expect(screen.queryByRole("table", { name: "Tokens that can reach your account" })).toBeNull();
    expect(screen.getByRole("button", { name: /3 tokens no longer reach your account/ })).toBeInTheDocument();
  });

  it("says in words that no token can reach the account when the account has never held one", () => {
    tokens = [];
    render(<TokensTab />);
    expect(screen.getByRole("status")).toHaveTextContent("No token can reach your account.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /no longer reach/ })).toBeNull();
  });

  it("moves a token out of the live table when its expiry passes while the screen stays open", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
      tokens = [aToken({ id: "soon", name: "soon", expiresAt: "2026-10-14T00:00:20.000Z" }), ...LIVE];
      render(<TokensTab />);
      expect(screen.getByRole("status")).toHaveTextContent("3 tokens can reach your account.");
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("2 tokens can reach your account.");
      expect(rowNames("Tokens that can reach your account")).not.toContain("soon");
      fireEvent.click(screen.getByRole("button", { name: /1 token no longer reaches your account/ }));
      expect(rowNames("Tokens that no longer reach your account")).toEqual(["soon"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what a live row reaches and who made it", () => {
    tokens = [
      aToken({ id: "b", name: "device:6f1c", scopes: ["read", "write"], grant: "full", permissions: ["*"] }),
      aToken({ id: "y", name: "ci", scopes: ["admin"], grant: "named", permissions: ["issues:read"], boundProjectId: null }),
    ];
    render(<TokensTab />);
    const live = screen.getByRole("table", { name: "Tokens that can reach your account" });
    expect(within(live).getByText(/made by a paired box/)).toBeInTheDocument();
    expect(within(live).getByText(/made by you/)).toBeInTheDocument();
    expect(within(live).getByText("Full access")).toBeInTheDocument();
    expect(within(live).getByText("1 permission")).toBeInTheDocument();
    expect(within(live).getAllByText("User-level").length).toBeGreaterThan(0);
  });

  it("sorts the live tokens from their headers, through the shared table, and keeps the Name column pinned", () => {
    render(<TokensTab />);
    const live = screen.getByRole("table", { name: "Tokens that can reach your account" });
    const name = within(live).getByRole("columnheader", { name: /Name/ });
    expect(name).toHaveClass("sticky");
    expect(name).toHaveAttribute("aria-sort", "none");
    fireEvent.click(within(name).getByRole("button"));
    expect(name).toHaveAttribute("aria-sort", "ascending");
    expect(rowNames("Tokens that can reach your account")).toEqual(["iss974-walk-2", "iss974-walk-admin"]);
    fireEvent.click(within(name).getByRole("button"));
    expect(rowNames("Tokens that can reach your account")).toEqual(["iss974-walk-admin", "iss974-walk-2"]);
  });

  it("draws no card list beside the table for a narrow screen", () => {
    render(<TokensTab />);
    expect(screen.getAllByText("iss974-walk-2")).toHaveLength(1);
  });
});
