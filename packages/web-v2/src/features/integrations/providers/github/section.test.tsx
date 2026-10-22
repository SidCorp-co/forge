// @vitest-environment jsdom
//
// ISS-1115 asked for the state an owner measured on live forge-dev rather than a
// live specimen: a github binding row that survived a Disconnect — `active:
// false`, `config: {}` — which `listBindingsForProject` hands straight back, so
// the component sees a row and no repository. `GITHUB_EMPTY_INACTIVE` is that
// row.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import type { IntegrationSummary } from "../../types";
import { ApiError } from "@/lib/api/client";

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const BINDING = "3f7c1a44-9e52-4d6b-8a21-0b5c9d2e7f61";

const bind = vi.fn();
/** The connect start: asserted for the ownership choice it must NOT carry. */
const connectStart = vi.fn(async (_params: { org?: string; orgId?: string }) => ({
  postUrl: "https://github.com/settings/apps/new",
  state: "signed-state",
  manifest: { name: "Forge — Forge", default_permissions: { contents: "write" } },
}));
const update = vi.fn();
const remove = vi.fn();

let items: IntegrationSummary[] = [];
let connections: ConnectionDirectoryItem[] = [];

const REPOSITORIES = [
  {
    fullName: "SidCorp-co/forge",
    owner: "SidCorp-co",
    repo: "forge",
    installationId: 159473037,
  },
  {
    fullName: "SidCorp-co/forge-plugin",
    owner: "SidCorp-co",
    repo: "forge-plugin",
    installationId: 159473037,
  },
];

/** Overridden by the tests that need the App to answer with nothing, or to fail. */
let repos: {
  data?: { repositories: typeof REPOSITORIES; truncated: boolean };
  isLoading: boolean;
  isError: boolean;
  error: unknown;
};

/** The project's own org is what the App will belong to, so the screen reads it. */
let project = {
  id: PROJECT,
  orgId: "63b1b3a0-1f0e-4a77-9f2d-2c5e6a7b8c90",
  orgName: "SidCorp",
  orgIsPersonal: false,
  orgRole: "owner" as "owner" | "admin" | "member" | null,
};
/** A refused start re-reads the reader's projects, whose role decides what is offered. */
const projectsRefetch = vi.fn(async () => undefined);
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [project], refetch: projectsRefetch }),
}));

vi.mock("../../hooks", () => ({
  useIntegrationsList: () => ({ data: { items } }),
  useConnections: () => ({ data: { items: connections } }),
  useGitHubRepositories: () => repos,
  useBindExistingConnection: () => ({ mutate: bind, isPending: false, isError: false, error: null }),
  useUpdateProviderIntegration: () => ({
    mutate: update,
    isPending: false,
    isError: false,
    error: null,
  }),
  useDeleteProviderIntegration: () => ({
    mutate: remove,
    isPending: false,
    isError: false,
    error: null,
  }),
  useGitHubConnect: () => ({
    mutateAsync: connectStart,
    isPending: false,
    isError: false,
    error: null,
  }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
  useIsOrgAdmin: () => true,
}));

const { GitHubSection } = await import("./section");

expect.extend(matchers);

function binding(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: BINDING,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider: "github",
    role: "service",
    stages: [],
    config: {},
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "none",
    agentPathKind: "core-mediated",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  } as IntegrationSummary;
}

function connection(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: CONNECTION,
    ownerType: "org",
    ownerId: "63b1b3a0-1f0e-4a77-9f2d-2c5e6a7b8c90",
    provider: "github",
    displayName: "SidCorp-co App",
    config: {},
    active: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    usage: { bindings: [] },
    access: { reach: "org", canManage: true, ownerName: null },
    ...over,
  } as ConnectionDirectoryItem;
}

/** The measured state: Disconnect left the row behind, switched off and empty. */
const GITHUB_EMPTY_INACTIVE = binding({ active: false, bindingActive: false, config: {} });

const GITHUB_CONFIGURED = binding({
  config: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
  bindingConfig: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
});

function mount() {
  render(<GitHubSection projectId={PROJECT} />);
}

function picker(): HTMLSelectElement | null {
  return screen.queryByLabelText("Repository") as HTMLSelectElement | null;
}

function choose(fullName: string) {
  const select = picker();
  if (!select) throw new Error("the repository picker did not render");
  fireEvent.change(select, { target: { value: fullName } });
}

beforeEach(() => {
  bind.mockClear();
  update.mockClear();
  remove.mockClear();
  items = [];
  connections = [connection()];
  repos = {
    data: { repositories: REPOSITORIES, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
  };
});
afterEach(cleanup);

describe("a github binding that records a repository", () => {
  it("names that repository on the connected card", () => {
    items = [GITHUB_CONFIGURED];

    mount();

    expect(screen.getByText("SidCorp-co/forge")).toBeInTheDocument();
  });

  it("offers a control that reopens the picker, so a repository is changeable in place", () => {
    items = [GITHUB_CONFIGURED];
    mount();

    fireEvent.click(screen.getByRole("button", { name: /change repository/i }));

    expect(picker()).not.toBeNull();
  });

  it("changes the repository by patching that same row, with no `active` field on an active binding", () => {
    items = [GITHUB_CONFIGURED];
    mount();
    fireEvent.click(screen.getByRole("button", { name: /change repository/i }));

    choose("SidCorp-co/forge-plugin");
    fireEvent.click(screen.getByRole("button", { name: /^save repository$/i }));

    expect(bind).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const [vars] = update.mock.calls[0];
    expect(vars).toEqual({
      id: BINDING,
      body: {
        config: { owner: "SidCorp-co", repo: "forge-plugin", installationId: 159473037 },
      },
    });
    expect(vars.body).not.toHaveProperty("active");
  });
});

describe("a github binding row that records no repository", () => {
  it("renders the picker rather than the connected card when the row is switched off", () => {
    items = [GITHUB_EMPTY_INACTIVE];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("renders the picker when the row is still active", () => {
    items = [binding({ config: {} })];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("renders the picker when owner and repo are present but empty", () => {
    items = [binding({ config: { owner: "", repo: "" } })];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("renders the picker when owner and repo are not strings", () => {
    items = [binding({ config: { owner: 7, repo: false } })];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("patches the surviving row instead of asking for a second one the unique index refuses", () => {
    items = [GITHUB_EMPTY_INACTIVE];
    mount();

    choose("SidCorp-co/forge");
    fireEvent.click(screen.getByRole("button", { name: /^save repository$/i }));

    expect(bind).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].id).toBe(BINDING);
  });

  it("switches the row back on in the same write that gives it a repository", () => {
    items = [GITHUB_EMPTY_INACTIVE];
    mount();

    choose("SidCorp-co/forge");
    fireEvent.click(screen.getByRole("button", { name: /^save repository$/i }));

    expect(update.mock.calls[0][0].body).toEqual({
      config: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
      active: true,
    });
  });

  it("never prints the instruction that names an act which cannot work", () => {
    items = [GITHUB_EMPTY_INACTIVE];

    mount();

    expect(screen.queryByText(/reconnecting this project/i)).toBeNull();
  });
});

describe("the controls that belong to the binding row itself", () => {
  it("keeps Disconnect on the picker when the App answers with no repositories", () => {
    items = [binding({ config: {} })];
    repos = {
      data: { repositories: [], truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    mount();

    fireEvent.click(screen.getByRole("button", { name: /disconnect from this project/i }));

    expect(remove).toHaveBeenCalledWith(BINDING);
  });

  it("keeps Disconnect on the picker when the repository list fails to load", () => {
    items = [GITHUB_EMPTY_INACTIVE];
    repos = { isLoading: false, isError: true, error: new Error("boom") };
    mount();

    fireEvent.click(screen.getByRole("button", { name: /disconnect from this project/i }));

    expect(remove).toHaveBeenCalledWith(BINDING);
  });

  it("keeps the enable toggle on the picker, so a switched-off row has a way back either way", () => {
    items = [GITHUB_EMPTY_INACTIVE];

    mount();

    expect(screen.getByLabelText("Enabled for this project")).toBeInTheDocument();
  });
});

describe("a project with no github binding row at all", () => {
  it("renders the picker over the reusable connection", () => {
    items = [];

    mount();

    expect(picker()).not.toBeNull();
  });

  // ISS-1421 r8: a reusable connection whose App was never finished read "Invalid input".
  it("says what is missing where the reusable connection's App was never finished", () => {
    items = [];
    const said =
      "This GitHub connection has no App yet: creating it on GitHub was never finished. Use Create a separate App instead.";
    repos = { isLoading: false, isError: true, error: new ApiError(409, said, "GITHUB_APP_UNFINISHED") };

    mount();

    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.queryByText(/Invalid input/)).toBeNull();
  });

  it("still creates the binding through the bind-existing route, with the body it sent before", () => {
    items = [];
    mount();

    choose("SidCorp-co/forge");
    fireEvent.click(screen.getByRole("button", { name: /^connect repository$/i }));

    expect(update).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0][0]).toEqual({
      id: CONNECTION,
      body: {
        projectId: PROJECT,
        role: "service",
        config: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
        agentAccess: "none",
      },
    });
  });
});

/**
 * ISS-1216 — which reachable App a project is sent to. The directory now lists an App the caller
 * can see without being able to bind it, so the screen offers one the server would let this
 * project bind, and says who can bind the rest instead of walking the caller to a refusal or to a
 * second App without a word.
 */
describe("a project with no binding, offered the Apps the directory lists", () => {
  const OTHER_ORG = "7d1e0c11-0000-4000-8000-000000000001";
  const theirs = (over: Partial<ConnectionDirectoryItem> = {}) =>
    connection({
      ownerType: "user",
      ownerId: "someone-else",
      displayName: "Their App",
      access: { reach: "binding", canManage: false, ownerName: "Dana Reyes" },
      ...over,
    });

  beforeEach(() => {
    items = [];
  });

  it("offers an App the caller can manage that this project's own org owns", () => {
    connections = [connection({ displayName: "Own App" })];

    mount();

    expect(picker()).not.toBeNull();
    expect(screen.getByText("Own App")).toBeInTheDocument();
  });

  it("skips a manageable App owned by a different org and offers the compatible one listed after it", () => {
    connections = [
      connection({ id: "other-org-app", ownerId: OTHER_ORG, displayName: "Elsewhere App" }),
      connection({ id: "this-org-app", displayName: "Own App" }),
    ];

    mount();

    expect(screen.getByText("Own App")).toBeInTheDocument();
    expect(screen.queryByText("Elsewhere App")).toBeNull();
  });

  it("does not offer an App another user owns, and says who can bind it before offering a second one", () => {
    connections = [theirs()];

    mount();

    expect(picker()).toBeNull();
    expect(screen.getByRole("button", { name: /create github app/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Their App is owned by Dana Reyes, and only they can bind it/i),
    ).toBeInTheDocument();
  });

  it("says nothing extra where the workspace holds no App at all", () => {
    connections = [];

    mount();

    expect(screen.queryByText(/is owned by/i)).toBeNull();
  });
});

/**
 * The App's owner follows the project, so the create screen says who that is
 * instead of offering a choice the server does not honour. Offering
 * "Personal (only me)" there is how a project's App ended up reachable by one
 * person (ISS-1115).
 */
describe("the screen that creates a new App", () => {
  beforeEach(() => {
    items = [];
    connections = [];
    project = { ...project, orgIsPersonal: false, orgName: "SidCorp", orgRole: "owner" };
  });

  it("names the org the App will belong to rather than asking who should own it", () => {
    mount();

    expect(screen.queryByLabelText("Credential owner")).toBeNull();
    expect(screen.queryByText("Personal (only me)")).toBeNull();
    expect(screen.getByText(/will belong to SidCorp/i)).toBeInTheDocument();
  });

  it("starts the flow with no ownership choice, so the sentence above cannot go stale", async () => {
    // jsdom has no navigation, and the submit is what the real flow ends on.
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);
    mount();

    fireEvent.change(screen.getByLabelText("GitHub organization"), {
      target: { value: "SidCorp-co" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create github app/i }));
    await waitFor(() => expect(submit).toHaveBeenCalled());

    expect(connectStart).toHaveBeenCalledTimes(1);
    // Strict, so a lingering `orgId: undefined` key is a failure too: the point
    // is that no ownership choice is composed at all.
    expect(connectStart.mock.calls[0][0]).toStrictEqual({ org: "SidCorp-co" });
    submit.mockRestore();
  });

  it("tells a solo operator the App is theirs, since a personal org owns nothing shared", () => {
    project = { ...project, orgIsPersonal: true, orgName: "Chuong" };

    mount();

    expect(screen.getByText(/will belong to you/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Credential owner")).toBeNull();
  });

  // Owner ruling (ISS-1421 r23, criterion 254): core refuses a non-admin with ORG_ADMIN_REQUIRED.
  it.each([
    ["a plain member", "member" as const],
    ["a reader outside the org", null],
  ])("offers %s no Create button and names who can create the App instead", (_who, orgRole) => {
    project = { ...project, orgRole };
    mount();

    expect(screen.queryByRole("button", { name: /create github app/i })).toBeNull();
    expect(screen.queryByLabelText("GitHub organization")).toBeNull();
    expect(
      screen.getByText(/Only an owner or admin of SidCorp can create it, from this project's Integrations tab\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Creating it needs org admin there/)).toBeNull();
  });
});

// ISS-1421 r22, judge-91: the drawer sent an admin here to install the App again, and the panel
// listed no repositories, said the App "was never finished" and offered an Enable credential core
// refuses. A removed connection is switched off and holds no key.
describe("a project bound to a removed GitHub connection (criterion 224)", () => {
  const REMOVED = binding({
    active: false,
    connectionActive: false,
    hasSecrets: false,
    config: { owner: "SidCorp-co", repo: "forge" },
    bindingConfig: { owner: "SidCorp-co", repo: "forge" },
  });

  beforeEach(() => {
    items = [REMOVED];
    project = { ...project, orgIsPersonal: false, orgName: "SidCorp", orgRole: "owner" };
    connections = [connection({ active: false, hasSecrets: false })];
    repos = { isLoading: false, isError: false, error: null };
  });

  it("says the connection was removed and offers the install, with no picker and no Enable credential", () => {
    mount();

    expect(
      screen.getByText(/was removed, so this project's GitHub has no App/),
    ).toBeInTheDocument();
    expect(screen.getByText("SidCorp-co App")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install the GitHub App again" })).toBeInTheDocument();
    expect(picker()).toBeNull();
    expect(screen.queryByText("SidCorp-co/forge")).toBeNull();
    expect(screen.queryByRole("button", { name: /enable credential/i })).toBeNull();
    expect(screen.queryByText(/never finished/)).toBeNull();
    expect(screen.queryByRole("button", { name: /create a separate app/i })).toBeNull();
  });

  it("starts creating the App on GitHub for this project when Install is pressed", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);
    connectStart.mockClear();
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Install the GitHub App again" }));
    await waitFor(() => expect(submit).toHaveBeenCalled());

    expect(connectStart).toHaveBeenCalledTimes(1);
    expect(connectStart.mock.calls[0][0]).toStrictEqual({ org: undefined });
    submit.mockRestore();
  });

  // r23 preview: a refused install (ORG_ADMIN_REQUIRED) threw past the banner as an unhandled rejection.
  it("leaves a refused install to the banner, throwing nothing past it", async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);
    connectStart.mockRejectedValueOnce(new Error("Only an owner or admin of QA can create one."));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Install the GitHub App again" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandled).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
    submit.mockRestore();
  });

  // r24, judge-96: a refused install left the panel reading as for an org admin until a reload.
  it("re-reads the reader's projects when an install is refused, so what it offers follows their role", async () => {
    connectStart.mockRejectedValueOnce(new Error("Only an owner or admin of SidCorp can create one."));
    projectsRefetch.mockClear();
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Install the GitHub App again" }));

    await waitFor(() => expect(projectsRefetch).toHaveBeenCalledTimes(1));
  });

  it("keeps Disconnect as the way to leave the connection, asked once before it is sent", () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: /disconnect from this project/i }));
    expect(remove).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Disconnecting switches this project off from SidCorp-co App, so it stays off if the connection is turned back on from anywhere but here.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toBe(BINDING);
  });

  // r24, judge-96: Disconnect took effect on one click, though nothing in the panel undoes it.
  it("sends nothing when the Disconnect question is cancelled", () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: /disconnect from this project/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Disconnecting switches this project off/)).toBeNull();
  });

  it("asks without the exception where this project's install cannot turn the connection on", () => {
    connections = [connection({ active: false, hasSecrets: false, ownerType: "user", ownerId: "a-person" })];
    mount();

    fireEvent.click(screen.getByRole("button", { name: /disconnect from this project/i }));

    expect(
      screen.getByText(
        "Disconnecting switches this project off from SidCorp-co App, so it stays off if the connection is turned back on.",
      ),
    ).toBeInTheDocument();
  });

  // Whole-set review F1 (r23): core refuses an install whose App would belong to someone else
  // (REMOVED_CONNECTION_OTHER_OWNER), so the panel neither promises it nor offers it.
  it("offers no install where the App would belong to someone other than the connection's owner", () => {
    connections = [connection({ active: false, hasSecrets: false, ownerType: "user", ownerId: "a-person" })];
    mount();

    expect(screen.queryByRole("button", { name: "Install the GitHub App again" })).toBeNull();
    expect(screen.queryByText(/turns that connection back on/)).toBeNull();
    expect(
      screen.getByText(/would belong to someone other than that connection's owner, so it cannot turn it back on/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect from this project/i })).toBeInTheDocument();
  });

  it("offers a plain member of the org no Install button and names who can install it instead", () => {
    project = { ...project, orgRole: "member" };
    mount();

    expect(screen.queryByRole("button", { name: "Install the GitHub App again" })).toBeNull();
    expect(screen.queryByLabelText("GitHub organization")).toBeNull();
    expect(
      screen.getByText(/Only an owner or admin of SidCorp can install it, from this project's Integrations tab\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Creating it needs org admin there/)).toBeNull();
    expect(screen.queryByText(/creates it on GitHub/)).toBeNull();
    expect(screen.getByRole("button", { name: /disconnect from this project/i })).toBeInTheDocument();
  });

  it("tells a plain member whose App would belong to someone else only that, promising no admin a way back", () => {
    project = { ...project, orgRole: "member" };
    connections = [connection({ active: false, hasSecrets: false, ownerType: "user", ownerId: "a-person" })];
    mount();

    expect(screen.queryByRole("button", { name: "Install the GitHub App again" })).toBeNull();
    expect(screen.getByText(/cannot turn it back on/)).toBeInTheDocument();
    expect(screen.queryByText(/Only an owner or admin of/)).toBeNull();
  });

  it("still offers an org admin the install", () => {
    project = { ...project, orgRole: "admin" };
    mount();

    expect(screen.getByRole("button", { name: "Install the GitHub App again" })).toBeInTheDocument();
    expect(screen.queryByText(/Only an owner or admin of/)).toBeNull();
  });

  // r23 preview: Disconnect switched the binding off and the panel showed the same screen and the
  // same button, though a project switched off stays off when the connection is turned back on elsewhere.
  it("says a disconnected project stays off, and offers no second Disconnect (criterion 259)", () => {
    items = [{ ...REMOVED, bindingActive: false }];
    mount();

    expect(
      screen.getByText(/This project is disconnected from it, so it stays off if the connection is turned back on from anywhere but here\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /disconnect from this project/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Install the GitHub App again" })).toBeInTheDocument();
  });

  // The row a Disconnect leaves keeps the project's one GitHub service binding taken, so no new App is
  // offered while it stands; Clear deletes it (criterion 221).
  it("names Clear by the connection's owner as the way to a new App where this project's install cannot turn it on (criterion 260)", () => {
    connections = [connection({ active: false, hasSecrets: false, ownerType: "user", ownerId: "a-person" })];
    mount();

    expect(
      screen.getByText(/The connection's owner can clear it from the list on the Integrations page, and then a new App can be created here\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Disconnect it from this project to create a new App here/)).toBeNull();
  });

  it("names no install from here as an exception where this project's install cannot turn it on", () => {
    items = [{ ...REMOVED, bindingActive: false }];
    connections = [connection({ active: false, hasSecrets: false, ownerType: "user", ownerId: "a-person" })];
    mount();

    expect(
      screen.getByText(/This project is disconnected from it, so it stays off if the connection is turned back on\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/anywhere but here/)).toBeNull();
  });

  it("promises nothing about the way back where the connection is not in the reader's list", () => {
    connections = [];
    mount();

    expect(screen.getByText(/was removed, so this project's GitHub has no App/)).toBeInTheDocument();
    expect(screen.queryByText(/turns that connection back on/)).toBeNull();
    expect(screen.queryByText(/cannot turn it back on/)).toBeNull();
  });
});
