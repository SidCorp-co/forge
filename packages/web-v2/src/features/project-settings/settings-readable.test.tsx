// Settings read before they edit. The test accounts a run signs in with sit first on their own
// Testing tab, one row each, and their secrets are written and never read back; the raw documents
// every tab draws from are folded under Advanced; and each tab's rail lists that tab's own groups.

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V1Read } from "@/features/project-config";
import { fakeCore } from "@/test/render";
import { railBeside } from "@/test/rail-beside";
import { ProjectSettingsScreen } from "./components/project-settings-screen";
import { TestingSettings } from "./components/testing-tab";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/hop/settings",
  useParams: () => ({ slug: "hop" }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

const P = "11111111-1111-4111-8111-111111111111";
const MASK = "••••••••";
// What a stored value would look like were it ever drawn: core never sends one, and a page that drew
// what it was sent would show it here.
const LEAKED = "hunter2-catalog-admin";

const PROJECT_DOC = {
  $schema: "https://forge.sidcorp.co/schemas/project-v1.json",
  version: 1,
  project: { id: P, slug: "hop", name: "Hop" },
  source: { type: "git", git: { repository: "github.com/acme/hop", defaultBranch: "dev", branches: ["dev", "main"] } },
  workspace: { isolation: "worktree" },
  validation: { gate: { type: "none" } },
  environments: { dev: { tier: "dev", url: "https://hop.dev.example", testing: "dev-accounts" }, stg: { tier: "staging", testing: "dev-accounts" } },
  promotions: [],
  rollback: { strategy: "none" },
  execution: { plugin: { source: "SidCorp-co/forge-plugin", ref: "a".repeat(40) } },
};
const PROJECT: V1Read = { declared: true, revision: 6, document: PROJECT_DOC };

const PROFILE = {
  profileId: "dev-accounts",
  declared: true as const,
  revision: 3,
  document: {
    $schema: "https://forge.sidcorp.co/schemas/testing-profile-v1.json",
    version: 1,
    actors: {
      admin: { role: "project-admin", credential: "secret://dev/admin" },
      viewer: { role: "viewer", credential: "secret://dev/viewer" },
    },
    services: { "catalog-api": { access: "readonly", credential: "secret://dev/catalog-token", endpoint: "https://api.example" } },
    limits: [{ id: "no-prod", note: "Never sign in to production." }],
  },
};

const SECRETS = {
  secrets: [
    { ref: "secret://dev/admin", scope: "dev", name: "admin", updatedAt: "2026-10-02T09:00:00.000Z", value: LEAKED },
    { ref: "secret://dev/catalog-token", scope: "dev", name: "catalog-token", updatedAt: "2026-10-03T09:00:00.000Z" },
    { ref: "secret://dev/old-key", scope: "dev", name: "old-key", updatedAt: "2026-10-02T09:00:00.000Z" },
  ],
  returned: 3,
};

const LIST = [{ id: P, slug: "hop", name: "Hop", orgId: "o1", orgName: "Acme", orgIsPersonal: false, createdBy: "u1", role: "admin", orgRole: "owner", archivedAt: null, createdAt: "2026-10-01T00:00:00Z" }];
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], devicePool: [], agentConfig: {}, archivedAt: null };

const data = (): [QueryKey, unknown][] => [
  [["projects", "all"], LIST],
  [["project", P], DETAIL],
  [["project", P, "config"], PROJECT],
  [["project", P, "policy"], { declared: false, revision: null, document: null }],
  [["project", P, "bindings"], { bindings: [], unrepresentable: [], returned: 0 }],
  [["project", P, "testing-profiles"], { profiles: [PROFILE], returned: 1 }],
  [["project", P, "secrets"], SECRETS],
  [["project", P, "content-language"], { contentLanguage: "en", keepTermsInEnglish: [], revision: 6 }],
];

/** A fresh client per render, seeded with the project's documents as core would answer them. */
function seeded(extra: [QueryKey, unknown][] = []): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } } });
  for (const [key, value] of [...data(), ...extra]) client.setQueryData(key, value);
  return client;
}

/** Renders `ui` against a client seeded once, for this render only. */
const renderSeeded = (ui: ReactNode, extra: [QueryKey, unknown][] = []) => render(<QueryClientProvider client={seeded(extra)}>{ui}</QueryClientProvider>);

const testing = () =>
  renderSeeded(<TestingSettings projectId={P} canEdit />);
const rowOf = (name: string) => {
  const row = screen.getAllByTestId("testing-credential").find((r) => within(r).queryByText(name, { exact: true }));
  if (!row) throw new Error(`no test account row names ${name}`);
  return row;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("every test account is one row with its role, environment and masked value", () => {
  it("draws each actor and service a profile names as one row", () => {
    fakeCore(() => ({ hang: true }));
    testing();
    expect(screen.getAllByTestId("testing-credential").map((r) => within(r).getByText(/^(admin|viewer|catalog-api)$/).textContent)).toEqual(["admin", "viewer", "catalog-api"]);
  });

  it("says the account's role and the environments that sign in with it", () => {
    fakeCore(() => ({ hang: true }));
    testing();
    const admin = rowOf("admin");
    expect(admin).toHaveTextContent("Project admin");
    expect(admin).toHaveTextContent("Used in dev, stg");
    expect(rowOf("catalog-api")).toHaveTextContent("Service, reads only");
  });

  it("shows a stored value as a mask, and an unstored one as not set", () => {
    fakeCore(() => ({ hang: true }));
    testing();
    expect(within(rowOf("admin")).getByText(MASK)).toBeInTheDocument();
    expect(rowOf("admin")).toHaveTextContent(/Value set/);
    expect(within(rowOf("viewer")).queryByText(MASK), "a mask over a value that was never stored").toBeNull();
    expect(within(rowOf("viewer")).getByText("Not set")).toBeInTheDocument();
  });

  it("lists only the secrets no account names as other secrets", () => {
    fakeCore(() => ({ hang: true }));
    testing();
    const other = screen.getByRole("region", { name: "Other secrets" });
    expect(within(other).getByText("secret://dev/old-key")).toBeInTheDocument();
    expect(within(other).queryByText("secret://dev/admin")).toBeNull();
  });

  it("dates an unused secret's value as it dates an account's", () => {
    fakeCore(() => ({ hang: true }));
    testing();
    // old-key and admin were written at the same moment, so the two lists must say the same date
    const other = within(screen.getByRole("region", { name: "Other secrets" })).getByText("secret://dev/old-key").closest("li");
    const at = (el: Element | null) => [...(el?.querySelectorAll("[data-testid='row-facts'] > span") ?? [])].map((f) => f.textContent?.replace("·", "").trim()).find((f) => f?.startsWith("Value set"));
    expect(at(other), "the two lists write one date two ways").toBe(at(rowOf("admin")));
  });
});

describe("a secret's value is never rendered", () => {
  it("draws nothing of a value core sent alongside a secret's name", () => {
    fakeCore(() => ({ hang: true }));
    const { container } = testing();
    fireEvent.click(screen.getByRole("button", { name: /Raw document/ }));
    expect(container.innerHTML, "the stored value reached the page").not.toContain(LEAKED);
  });

  it("keeps no trace of a value once it is written", async () => {
    fakeCore((c) => (c.method === "PUT" ? { body: { ref: "secret://dev/admin", scope: "dev", name: "admin", updatedAt: "2026-10-14T09:00:00.000Z" } } : { hang: true }));
    const { container } = testing();
    fireEvent.click(within(rowOf("admin")).getByRole("button", { name: "Replace value" }));
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "typed-new-value" } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save value" }));
    });
    await waitFor(() => expect(screen.queryByLabelText("New value")).toBeNull());
    expect(container.innerHTML, "the written value is still on the page").not.toContain("typed-new-value");
  });
});

describe("Replace value is write-only", () => {
  it("opens an empty password field, writes the value once, and never asks for it back", async () => {
    const calls = fakeCore((c) => (c.method === "PUT" ? { body: { ref: "secret://dev/admin", scope: "dev", name: "admin", updatedAt: "2026-10-14T09:00:00.000Z" } } : { hang: true }));
    testing();
    fireEvent.click(within(rowOf("admin")).getByRole("button", { name: "Replace value" }));
    const field = screen.getByLabelText("New value");
    expect(field, "a field that shows what is typed").toHaveAttribute("type", "password");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(field, { target: { value: "typed-new-value" } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save value" }));
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/projects/${P}/secrets/dev/admin`);
    expect(put?.body).toEqual({ value: "typed-new-value" });
    expect(calls.filter((c) => c.method === "GET" && /\/secrets\/[^/?]+\/[^/?]+/.test(c.path)), "a read of one secret's value").toEqual([]);
  });

  it("is not offered to a reader who cannot edit", () => {
    fakeCore(() => ({ hang: true }));
    renderSeeded(<TestingSettings projectId={P} canEdit={false} />);
    expect(screen.queryByRole("button", { name: /Replace value|Set value/ })).toBeNull();
    expect(within(rowOf("admin")).getByText(MASK)).toBeInTheDocument();
  });
});

describe("raw documents are folded by default", () => {
  it("folds each raw document on Advanced, drawing none of their editors", async () => {
    window.history.replaceState(null, "", "/projects/hop/settings?tab=advanced");
    fakeCore(() => ({ hang: true }));
    renderSeeded(<ProjectSettingsScreen slug="hop" />);
    const docs = await screen.findByRole("region", { name: "Raw documents" });
    const folds = ["Project document", "Policy", "How connections are used", "What a run reads"].map((name) => within(docs).getByRole("button", { name: new RegExp(`^${name}`) }));
    for (const fold of folds) expect(fold, `${fold.textContent} opens by itself`).toHaveAttribute("aria-expanded", "false");
    expect(within(docs).queryByRole("textbox"), "an editor drawn inside a fold").toBeNull();
  });

  it("folds a profile's raw document under its accounts", () => {
    fakeCore(() => ({ hang: true }));
    testing();
    expect(screen.getByRole("button", { name: /^Raw document/ })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("each tab's rail lists its own groups", () => {
  const railOn = async (tab: string, extra: [QueryKey, unknown][] = []) => {
    window.history.replaceState(null, "", `/projects/hop/settings?tab=${tab}`);
    railBeside();
    fakeCore(() => ({ hang: true }));
    renderSeeded(<ProjectSettingsScreen slug="hop" />, extra);
    const rail = await screen.findByTestId("settings-contents");
    return () => within(rail).getAllByRole("link").map((a) => a.textContent);
  };

  it("lists Testing's groups on Testing", async () => {
    const links = await railOn("testing");
    await waitFor(() => expect(links()).toEqual(["Test accounts", "Other secrets"]));
  });

  it("lists Advanced's groups on Advanced, and none of Testing's", async () => {
    const links = await railOn("advanced");
    // the org can move the project nowhere (no other org it administers is seeded), so Move is neither drawn nor listed
    await waitFor(() => expect(links()).toEqual(["Computation", "Plugins", "Raw documents", "Archive project"]));
    expect(screen.getByRole("heading", { name: "Archive project" }), "an entry whose heading is not where it points").toBeInTheDocument();
  });

  it("lists moving the project under its own name where there is an org to move it to", async () => {
    const orgs = [
      { id: "o1", name: "Acme", role: "owner" },
      { id: "o2", name: "Beta", role: "admin" },
    ];
    const links = await railOn("advanced", [[["orgs"], orgs]]);
    await waitFor(() => expect(links()).toEqual(["Computation", "Plugins", "Raw documents", "Move to another organization", "Archive project"]));
  });

  it("lists Delivery's groups on Delivery", async () => {
    const links = await railOn("delivery");
    await waitFor(() => expect(links()).toContain("Environments"));
    expect(links()).not.toContain("Raw documents");
  });

  it("names Runners in the contents on Connections, with no second heading stacked over the runner screen's own", async () => {
    const links = await railOn("connections");
    await waitFor(() => expect(links()).toEqual(["Integrations", "Runners"]));
    expect(screen.queryByRole("heading", { name: "Runners" }), "Runners stacked over Add a device").toBeNull();
  });
});
