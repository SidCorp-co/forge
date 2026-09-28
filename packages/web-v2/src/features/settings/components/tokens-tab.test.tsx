// @vitest-environment jsdom
//
// ISS-1255 — the grant is the minter's choice, and the form makes none for
// them. What is asserted below is that choice: a fresh form holds none, it
// will not submit until one is made, each choice reaches the door as the
// value the door accepts, and the list afterwards says which of the three
// grants each token carries.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  useRevokeToken: () => ({ mutate: vi.fn(), isPending: false }),
  useReauth: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { TokensTab } from "./tokens-tab";

const nameField = () => screen.getByPlaceholderText("e.g. CI deploy token");
const createButton = () => screen.getByRole("button", { name: "Create token" });

beforeEach(() => {
  tokens = [];
  createMutate.mockClear();
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
