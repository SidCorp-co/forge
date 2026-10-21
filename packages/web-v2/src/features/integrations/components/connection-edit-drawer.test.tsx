// @vitest-environment jsdom
//
// ISS-1216 — the drawer's "Projects using it" panel over a refusal. A 404 or 403 answers the same
// way every time, so the panel prints the server's sentence and offers no Retry; a 5xx or a lost
// connection can answer differently, so it keeps one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

let bindingsError: unknown = null;
let bindingsData: unknown;
let bindingsPending = false;
const updateMutate = vi.fn();
const removeMutate = vi.fn();

vi.mock("../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks")>()),
  useConnectionBindings: () => ({
    data: bindingsData,
    isSuccess: bindingsError === null && !bindingsPending,
    isLoading: bindingsPending,
    isError: bindingsError !== null,
    error: bindingsError,
    refetch: vi.fn(),
  }),
  useUpdateConnection: () => ({ mutate: updateMutate, isPending: false }),
  useRemoveConnection: () => ({ mutate: removeMutate, isPending: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({
    data: [
      { id: "p-store", name: "Storefront", slug: "storefront", archivedAt: null },
      { id: "p-shop", name: "Shop", slug: "shop", archivedAt: null },
    ],
  }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConnectionEditDrawer, testOutcome } = await import("./connection-edit-drawer");

expect.extend(matchers);

const connection: ConnectionDirectoryItem = {
  id: "2679a042-4da4-48dd-bcfa-933c70ba91da",
  ownerType: "user",
  ownerId: "someone-else",
  provider: "github",
  displayName: "Forge GitHub App",
  config: {},
  active: true,
  lastHealthStatus: "ok",
  lastHealthAt: "2026-09-20T00:00:00.000Z",
  breakerOpenedAt: null,
  hasSecrets: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  usage: { bindings: [] },
  access: { reach: "binding", canManage: false, ownerName: "Dana Reyes" },
};

function mount(over: Partial<ConnectionDirectoryItem> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionEditDrawer connection={{ ...connection, ...over }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  bindingsError = null;
  bindingsData = undefined;
  bindingsPending = false;
  updateMutate.mockClear();
  removeMutate.mockClear();
});
afterEach(cleanup);

describe("the drawer's Projects using it panel over a refusal", () => {
  it("prints the server's sentence for a connection it cannot reach, with no Retry that would meet it again", () => {
    const sentence = `Connection ${connection.id} is not one you can reach. Ask its owner.`;
    bindingsError = new ApiError(404, sentence, "CONNECTION_NOT_REACHABLE");

    mount();

    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps Retry for a server failure, which can answer differently the next time", () => {
    bindingsError = new ApiError(503, "unavailable", "INTERNAL_ERROR");

    mount();

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

// ISS-1421 r17 — judge-73 read "Test failed: error — …" and "Test failed: needs_reauth — …": the
// failure said twice, and a stored status value set beside a badge that words it for a person.
describe("the drawer's Test connection line", () => {
  it("is the provider's own sentence when it gave one, with no stored status before it", () => {
    const said =
      "Forge could not check Coolify. The server at example.com answered 404 Not Found to GET /api/v1/resources, so it may not be Coolify. Check the address saved on this connection, then test again.";
    expect(testOutcome({ status: "error", message: said })).toBe(said);
    expect(testOutcome({ status: "needs_reauth", message: "Postman refused the stored credential." })).toBe(
      "Postman refused the stored credential.",
    );
  });

  it("words a status for a person when the provider gave no sentence", () => {
    expect(testOutcome({ status: "ok" })).toBe("The connection works.");
    expect(testOutcome({ status: "needs_reauth" })).toBe("It needs signing in again.");
    expect(testOutcome({ status: "error" })).toBe("The last check failed.");
    for (const status of ["error", "needs_reauth", "needs_scope"]) {
      const line = testOutcome({ status });
      expect(line).not.toContain(status);
      expect(line).not.toMatch(/Test failed/);
    }
  });
});

// ISS-1421 r18 — judge-75 at 390: a 53-character name cut mid-word with Close pushed off screen.
describe("the drawer header's connection name", () => {
  it("may shrink to the drawer's width, ellipsised, with the whole name on hover", () => {
    const long = "j75 Coolify production eu-west primary box number one again";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionEditDrawer connection={{ ...connection, displayName: long }} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const name = screen.getByTestId("connection-drawer-name");
    expect(name).toHaveTextContent(long);
    expect(name).toHaveAttribute("title", long);
    for (const cls of ["min-w-0", "max-w-full", "truncate"]) expect(name.className).toContain(cls);
  });
});


// ISS-1421 r19 — judge-79 read "the previous key stays valid for 24h" on a Coolify token: nothing
// keeps a key valid at Coolify. Forge keeps the replaced key and falls back to it, and only where
// it is used is that said, as it is used. r20 — judge-82 found Sentry keeps and uses it too, so its
// line says so; Postman, Epodsystem, Rocket.Chat and GitHub keep none, and theirs say nothing.
describe("the drawer's Replace key line", () => {
  const managed = { access: { ...connection.access, canManage: true } };

  it("says what Forge does with the previous key for a provider that uses it", () => {
    mount({ ...managed, provider: "coolify" });
    expect(
      screen.getByText(
        "A key is stored (never shown). Forge keeps the previous key for 24 hours and uses it for its own calls wherever Coolify refuses the new one.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/stays valid/)).toBeNull();
    cleanup();
    mount({ ...managed, provider: "sentry" });
    expect(
      screen.getByText(
        "A key is stored (never shown). Forge keeps the previous key for 24 hours and uses it for its own calls wherever Sentry refuses the new one.",
      ),
    ).toBeInTheDocument();
    cleanup();
    mount({ ...managed, provider: "google" });
    expect(
      screen.getByText(
        "A key is stored (never shown). Forge keeps the previous key for 24 hours and signs in with it wherever Google refuses the new one.",
      ),
    ).toBeInTheDocument();
  });

  it("makes no 24-hour claim for a provider that keeps no previous key", () => {
    for (const provider of ["rocketchat", "postman", "epodsystem"] as const) {
      mount({ ...managed, provider });
      expect(screen.getByText("A key is stored (never shown). Enter a new one to replace it.")).toBeInTheDocument();
      expect(screen.queryByText(/24 hours|24h/)).toBeNull();
      cleanup();
    }
    mount({ ...managed, provider: "github" });
    expect(screen.queryByText(/previous key|24 hours|24h/)).toBeNull();
  });
});

// ISS-1421 r20 — judge-82: a removed connection kept its keys, so Enable brought them back. Removing
// now wipes them and core refuses to turn a keyless connection on, so the drawer offers no Enable
// that can only be refused, and says what turns it on.
describe("the drawer's Danger zone over a connection that was removed", () => {
  const mine = { access: { reach: "owner", canManage: true, ownerName: null } } as never;

  it("offers no Enable on a connection holding no key, and says a new key turns it on", () => {
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: false });
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(
      screen.getByText("This connection holds no key. Saving a new key above turns it back on."),
    ).toBeInTheDocument();
  });

  // ISS-1421 r21 — judge-89: the drawer sent a removed GitHub connection's owner to an App install
  // that made a second connection, and said the installation held a credential it did not.
  it("says a fresh App install from the project bound to a removed GitHub connection turns it on", () => {
    // The binding is on and its connection off, as a remove leaves them: no "binding disabled".
    bindingsData = {
      items: [
        { id: "b1", projectId: "p-store", active: false, bindingActive: true, role: "service", stages: [] },
      ],
    };
    mount({ ...(mine as object), provider: "github", active: false, hasSecrets: false });
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.queryByText(/Saving a new key above/)).toBeNull();
    expect(
      screen.getByText(
        "This connection holds no key. Installing the GitHub App again from the Integrations tab of Storefront turns it back on.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/The App installation holds this credential/)).toBeNull();
    expect(screen.queryByText("binding disabled")).toBeNull();
    expect(screen.queryByText("Configuration")).toBeNull();
  });

  it("says nothing turns a removed GitHub connection on where no project is bound to it", () => {
    mount({ ...(mine as object), provider: "github", active: false, hasSecrets: false });
    expect(
      screen.getByText(
        "This connection holds no key and no project is bound to it, so nothing can turn it back on. Clear it from the list.",
      ),
    ).toBeInTheDocument();
  });

  // Whole-set review F1: an unread binding list is not an empty one.
  it("claims nothing and offers no Clear while the projects bound to a removed GitHub connection are unread", () => {
    for (const unread of [() => { bindingsPending = true; }, () => { bindingsError = new ApiError(500, "Boom.", "INTERNAL_ERROR"); }]) {
      cleanup();
      bindingsPending = false;
      bindingsError = null;
      unread();
      mount({ ...(mine as object), provider: "github", active: false, hasSecrets: false });
      expect(screen.queryByText(/no project is bound/)).toBeNull();
      expect(
        screen.getByText("This connection holds no key. What turns it back on is said once its projects are read."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Clear from list…" })).toBeDisabled();
    }
  });

  it("names the projects a clear deletes the binding of", () => {
    bindingsData = { items: [{ id: "b1", projectId: "p-store", active: false, bindingActive: true, role: "service", stages: [] }] };
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: false });
    fireEvent.click(screen.getByRole("button", { name: "Clear from list…" }));
    expect(
      screen.getByText("Clearing this connection deletes it for good, with its binding to Storefront."),
    ).toBeInTheDocument();
  });

  it("offers to clear a removed connection from the list, and clears it", () => {
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: false });
    expect(screen.queryByRole("button", { name: "Remove…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear from list…" }));
    expect(
      screen.getByText("Clearing this connection deletes it for good."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear connection" }));
    expect(removeMutate.mock.calls[0]?.[0]).toBe(connection.id);
  });

  it("offers Remove, never Clear, on a connection that still holds its key", () => {
    mount({ ...(mine as object), provider: "postman", active: true, hasSecrets: true });
    expect(screen.getByRole("button", { name: "Remove…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear from list…" })).toBeNull();
  });

  // ISS-1421 r22, judge-91: Clear deletes every binding, so the projects are joined with "and".
  it("says a clear deletes its bindings to each project it is bound to (criterion 236)", () => {
    bindingsData = {
      items: [
        { id: "b1", projectId: "p-store", active: false, bindingActive: true, role: "service", stages: [] },
        { id: "b2", projectId: "p-shop", active: false, bindingActive: true, role: "service", stages: [] },
      ],
    };
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: false });
    fireEvent.click(screen.getByRole("button", { name: "Clear from list…" }));
    expect(
      screen.getByText(/^Clearing this connection deletes it for good, with its bindings to (Storefront and Shop|Shop and Storefront)\.$/),
    ).toBeInTheDocument();
  });

  // ISS-1421 r22, judge-91: Test on a removed connection could only record a failure, and the
  // empty projects line said to share a connection core now refuses to share.
  it("offers no Test connection and no share hint on a removed connection (criterion 229)", () => {
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: false });
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.queryByText(/Share it from a project/)).toBeNull();
    expect(screen.getByText("No project uses this connection.")).toBeInTheDocument();
  });

  it("keeps Test connection and the share hint on a connection that holds its key", () => {
    mount({ ...(mine as object), provider: "postman", active: true, hasSecrets: true });
    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
    expect(screen.getByText(/Share it from a project/)).toBeInTheDocument();
  });

  it("offers Enable on a disabled connection that still holds its key", () => {
    mount({ ...(mine as object), active: false, hasSecrets: true });
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.queryByText(/holds no key/)).toBeNull();
  });
});

describe("the drawer's Save key over a connection holding no key", () => {
  const mine = { access: { reach: "owner", canManage: true, ownerName: null } } as never;
  const save = () => {
    fireEvent.change(document.querySelector("input[type=password]") as HTMLInputElement, {
      target: { value: "scratch-fresh-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    return updateMutate.mock.calls[0]?.[0];
  };

  it("turns a removed connection back on with the key it saves, as the line under it says", () => {
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: false });
    expect(screen.getByText("No key is stored. Enter one to activate this connection.")).toBeInTheDocument();
    expect(save()).toEqual({
      id: connection.id,
      body: { secrets: { apiKey: "scratch-fresh-key" }, active: true },
    });
  });

  it("leaves a connection someone disabled turned off when its key is replaced", () => {
    mount({ ...(mine as object), provider: "postman", active: false, hasSecrets: true });
    expect(save()).toEqual({ id: connection.id, body: { secrets: { apiKey: "scratch-fresh-key" } } });
  });
});
