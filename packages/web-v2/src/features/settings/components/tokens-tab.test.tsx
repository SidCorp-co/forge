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
import { PAT_NAME_IN_USE, type PatToken } from "../types";

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
let projects: { id: string; name: string; slug: string }[] = [];
const createMutate = vi.fn();
const revokeMutate = vi.fn();
const toastSpy = vi.fn();
const dismissSpy = vi.fn();

const projectsRead = { failed: false, refetched: 0 };
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () =>
    projectsRead.failed
      ? {
          data: undefined,
          isLoading: false,
          isError: true,
          error: new Error("The server ran into a problem and could not finish the request."),
          refetch: async () => {
            projectsRead.refetched += 1;
          },
        }
      : { data: projects, isLoading: false, isError: false },
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: toastSpy, dismiss: dismissSpy }) }));
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
  projects = [];
  projectsRead.failed = false;
  projectsRead.refetched = 0;
  createMutate.mockClear();
  revokeMutate.mockClear();
  toastSpy.mockClear();
  dismissSpy.mockClear();
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
    expect(screen.getAllByText("issues:read").length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole("button", { name: "Revoke token" }));
    expect(revokeMutate).toHaveBeenCalledWith("l2");
  });

  it("asks first, naming the token, and revokes nothing until it is confirmed", () => {
    render(<TokensTab />);
    const live = screen.getByRole("table", { name: "Tokens that can reach your account" });
    fireEvent.click(within(live).getByRole("button", { name: "Revoke, iss974-walk-2" }));
    expect(screen.getByText('Revoke "iss974-walk-2"?')).toBeInTheDocument();
    expect(revokeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revokeMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Revoke "iss974-walk-2"?')).toBeNull();
  });

  it("names every permission a named token holds, not how many", () => {
    tokens = [aToken({ id: "n", name: "ci", grant: "named", permissions: ["issues:read", "schedules:write"] })];
    render(<TokensTab />);
    const live = screen.getByRole("table", { name: "Tokens that can reach your account" });
    expect(within(live).getByText("issues:read")).toBeInTheDocument();
    expect(within(live).getByText("schedules:write")).toBeInTheDocument();
    expect(within(live).queryByText(/\d permissions?$/)).toBeNull();
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
    expect(within(live).getByText("issues:read")).toBeInTheDocument();
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

describe("TokensTab — the level a project token is bound to", () => {
  const BOUND = "00000000-0000-0000-0000-0000000000aa";

  it("names the project by its name, and not by its slug", () => {
    projects = [{ id: BOUND, name: "Forge Platform", slug: "forge-dev" }];
    tokens = [aToken({ id: "t1", name: "ci", boundProjectId: BOUND })];
    render(<TokensTab />);
    expect(screen.getByText("Project: Forge Platform")).toBeInTheDocument();
    expect(screen.queryByText("Project: forge-dev")).toBeNull();
  });

  it("falls back to the slug where the project has no name, and to its id where it is not listed", () => {
    projects = [{ id: BOUND, name: "", slug: "forge-dev" }];
    tokens = [
      aToken({ id: "t1", name: "ci", boundProjectId: BOUND }),
      aToken({ id: "t2", name: "other", boundProjectId: "11111111-2222-3333-4444-555555555555" }),
    ];
    render(<TokensTab />);
    expect(screen.getByText("Project: forge-dev")).toBeInTheDocument();
    expect(screen.getByText("Project: 11111111")).toBeInTheDocument();
  });
});

// ISS-1289 — a create refused for fresh auth adds the password box below the whole form, under the
// fold at 1280x900. The setup pages' Check after Create token names that box, so it has to be in view.
describe("TokensTab — the re-auth prompt opens where the reader is looking", () => {
  it("brings the Confirm password box into view and puts the cursor in it", async () => {
    const { ApiError } = await import("@/lib/api/client");
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    createMutate.mockImplementationOnce((_input, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new ApiError(403, "fresh auth", "FRESH_AUTH_REQUIRED")),
    );
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(scroll).not.toHaveBeenCalled();

    fireEvent.click(createButton());

    const password = screen.getByPlaceholderText("Your account password");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toContainElement(password);
    expect(password).toHaveFocus();
  });
});

// ISS-1289 — Create token sits below the whole form, so a refused field near its top is drawn off
// screen at 1280x900 and at 390, and a reader repeating a setup page with its fixed name pressed the
// button and saw nothing change. The first refused field comes into view and takes the cursor.
describe("TokensTab — a refused create shows the reader the field it refused", () => {
  const scroll = () => vi.mocked(Element.prototype.scrollIntoView);

  it("brings a name an active token holds into view, highlighted with the cursor in it, and sends nothing", () => {
    tokens = [aToken({ name: "Claude Code" }), aToken({ id: "2", name: "old", revokedAt: "2026-01-02T00:00:00.000Z" })];
    scroll().mockClear();
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "Claude Code" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    createButton().focus();

    fireEvent.click(createButton());

    expect(createMutate).not.toHaveBeenCalled();
    const input = nameField() as HTMLInputElement;
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Claude Code".length]);
    const refusal = screen.getByRole("alert");
    expect(refusal).toHaveTextContent(PAT_NAME_IN_USE);
    expect(scroll()).toHaveBeenCalledTimes(1);
    expect(scroll().mock.contexts[0]).toContainElement(input);
    expect(scroll().mock.contexts[0]).toContainElement(refusal);
    expect(input).toHaveAccessibleDescription(PAT_NAME_IN_USE);
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("lets a revoked token's name through", () => {
    tokens = [aToken({ name: "Claude Code", revokedAt: "2026-01-02T00:00:00.000Z" })];
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "Claude Code" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PAT_NAME_IN_USE)).toBeNull();
  });

  it("puts the cursor on the first Scopes box when no scope is ticked", () => {
    scroll().mockClear();
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "read" }));
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "read" })).toHaveFocus();
    expect(scroll().mock.contexts.at(-1)).toContainElement(screen.getByText("Select at least one scope."));
  });

  it("puts the cursor on the first Permissions choice when none is made", () => {
    scroll().mockClear();
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(createButton());
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /Full access/ })).toHaveFocus();
    expect(scroll().mock.contexts.at(-1)).toContainElement(screen.getByText("Choose what this token may reach."));
  });

  it("takes the field nearest the top when several are refused, and moves nothing on a create that goes", () => {
    scroll().mockClear();
    render(<TokensTab />);
    fireEvent.click(createButton());
    expect(nameField()).toHaveFocus();
    expect(scroll()).toHaveBeenCalledTimes(1);

    scroll().mockClear();
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(scroll()).not.toHaveBeenCalled();
  });
});

// ISS-1289 — the toast lane sits top right, over the right-hand drawer, so a toast confirming the copy
// covered the Token created panel's first line at 1280. The panel says its own result, and the form's
// notices, which can still be showing when a quick create opens the panel, are dismissed as it opens.
describe("TokensTab — the Token created panel says its own copy result", () => {
  const created = { ...aToken({ name: "ci" }), plaintext: "forge_pat_abc" };

  async function openPanel() {
    createMutate.mockImplementationOnce((_input, opts: { onSuccess: (t: unknown) => void }) => opts.onSuccess(created));
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    return screen.getByRole("dialog");
  }

  function clipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  }

  it("dismisses the form's notices as the panel opens", async () => {
    await openPanel();
    expect(dismissSpy).toHaveBeenCalledWith("token-form");
  });

  it("puts every notice the form raises in that one slot", async () => {
    const { ApiError } = await import("@/lib/api/client");
    createMutate.mockImplementationOnce((_input, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new ApiError(403, "fresh auth", "FRESH_AUTH_REQUIRED")),
    );
    createMutate.mockImplementationOnce((_input, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new ApiError(500, "boom", "INTERNAL")),
    );
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    cleanup();
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(toastSpy).toHaveBeenCalledTimes(2);
    for (const [notice] of toastSpy.mock.calls) expect(notice).toMatchObject({ slot: "token-form" });
  });

  it("turns Copy to clipboard into Copied ✓ and raises no toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const panel = await openPanel();
    toastSpy.mockClear();

    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Copy to clipboard" })));

    expect(writeText).toHaveBeenCalledWith("forge_pat_abc");
    expect(within(panel).getByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("says a refused copy inside the panel, and raises no toast", async () => {
    clipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const panel = await openPanel();
    toastSpy.mockClear();

    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Copy to clipboard" })));

    expect(within(panel).getByRole("alert")).toHaveTextContent("Copy failed. Select the token above and copy it by hand.");
    expect(within(panel).getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

// ISS-1289 — a refusal describes what the field holds now. It stayed under Name, invalid and
// describing it, after the reader typed a new, free name, until Create token was pressed again.
describe("TokensTab — a refusal leaves once its field no longer holds what it refused", () => {
  const refusal = (text: string) => screen.queryAllByRole("alert").find((el) => el.textContent === text) ?? null;
  const scopesGroup = () => screen.getByRole("checkbox", { name: "read" }).closest("div[aria-describedby]");

  it("goes when Name holds a new name, and is back when the refused name is typed back", () => {
    tokens = [aToken({ name: "Claude Code" })];
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "Claude Code" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(refusal(PAT_NAME_IN_USE)).not.toBeNull();

    fireEvent.change(nameField(), { target: { value: "Claude Code 2" } });
    expect(refusal(PAT_NAME_IN_USE)).toBeNull();
    expect(nameField()).not.toHaveAttribute("aria-invalid");
    expect(nameField()).not.toHaveAttribute("aria-describedby");

    fireEvent.change(nameField(), { target: { value: "Claude Code " } });
    expect(refusal(PAT_NAME_IN_USE)).not.toBeNull();
    expect(nameField()).toHaveAccessibleDescription(PAT_NAME_IN_USE);
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("goes when Name holds another taken name nobody pressed Create token on", () => {
    tokens = [aToken({ name: "Claude Code" }), aToken({ id: "2", name: "Cursor" })];
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "Claude Code" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(refusal(PAT_NAME_IN_USE)).not.toBeNull();

    fireEvent.change(nameField(), { target: { value: "Cursor" } });
    expect(refusal(PAT_NAME_IN_USE)).toBeNull();
    expect(nameField()).not.toHaveAttribute("aria-invalid");
  });

  it("goes when the token that held the name is revoked", () => {
    tokens = [aToken({ name: "Claude Code" })];
    const { rerender } = render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "Claude Code" } });
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(refusal(PAT_NAME_IN_USE)).not.toBeNull();

    tokens = [aToken({ name: "Claude Code", revokedAt: "2026-01-02T00:00:00.000Z" })];
    rerender(<TokensTab />);
    expect(refusal(PAT_NAME_IN_USE)).toBeNull();
    expect(nameField()).not.toHaveAttribute("aria-invalid");
  });

  it("shows no refusal for a value Create token was never pressed on", () => {
    tokens = [aToken({ name: "Claude Code" })];
    render(<TokensTab />);
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(refusal("Name is required.")).not.toBeNull();

    fireEvent.change(nameField(), { target: { value: "Claude Code" } });
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(nameField()).not.toHaveAttribute("aria-invalid");
  });

  it("goes from Scopes when a scope is ticked, leaving the hint as its description", () => {
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "read" }));
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(createButton());
    expect(scopesGroup()).toHaveAccessibleDescription("Select at least one scope.");

    fireEvent.click(screen.getByRole("checkbox", { name: "write" }));
    expect(refusal("Select at least one scope.")).toBeNull();
    expect(scopesGroup()).toHaveAccessibleDescription("What this token may do.");
    expect(scopesGroup()).not.toHaveAttribute("aria-invalid");

    fireEvent.click(screen.getByRole("checkbox", { name: "write" }));
    expect(refusal("Select at least one scope.")).not.toBeNull();
  });

  it("goes from Permissions when a choice is made, and when a picked list gains a permission", () => {
    render(<TokensTab />);
    fireEvent.change(nameField(), { target: { value: "ci" } });
    fireEvent.click(createButton());
    expect(refusal("Choose what this token may reach.")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /permissions I pick/ }));
    expect(screen.queryAllByRole("alert")).toEqual([]);

    fireEvent.click(createButton());
    expect(refusal("Pick at least one permission, or choose full access.")).not.toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "issues:read" }));
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });
});

// ISS-1229 r47: with the projects read failing, Bind to a project offered only "None — user-level", as if
// the reader held no project to bind a token to.
describe("TokensTab — Bind to a project when the projects cannot be read", () => {
  it("says they could not be read and reads them again on Retry", () => {
    projectsRead.failed = true;
    render(<TokensTab />);
    const said = screen.getByTestId("token-projects-unread");
    expect(said).toHaveTextContent(
      "Your projects could not be read, so none can be chosen: The server ran into a problem and could not finish the request.",
    );
    fireEvent.click(within(said).getByRole("button", { name: "Retry" }));
    expect(projectsRead.refetched).toBe(1);
  });

  it("says nothing of a failure where the projects were read", () => {
    render(<TokensTab />);
    expect(screen.queryByTestId("token-projects-unread")).toBeNull();
  });
});
