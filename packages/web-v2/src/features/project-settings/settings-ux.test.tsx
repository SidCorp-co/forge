import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWriteProjectDocument } from "@/features/project-config/hooks";
import type { V1Read } from "@/features/project-config/types";
import { fakeCore } from "@/test/render";
import { DocumentEditor } from "./components/document-editor";
import { DocumentFields } from "./components/document-fields";
import { ProjectSettingsScreen } from "./components/project-settings-screen";
import { ReleaseSection } from "./components/release-section";
import type { ReleaseReadiness } from "./types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/hop/settings",
  useParams: () => ({ slug: "hop" }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

const P = "11111111-1111-4111-8111-111111111111";

const DOC = {
  $schema: "https://forge.sidcorp.co/schemas/project-v1.json",
  version: 1,
  project: { id: P, slug: "hop", name: "Hop" },
  source: { type: "git", git: { repository: "github.com/acme/hop", defaultBranch: "dev", branches: ["dev", "main"] } },
  workspace: { isolation: "worktree" },
  validation: { gate: { type: "none" } },
  environments: {},
  promotions: [],
  rollback: { strategy: "none" },
  execution: { plugin: { source: "SidCorp-co/forge-plugin", ref: "a".repeat(40) } },
};
const READ: V1Read = { declared: true, revision: 6, document: DOC };

function Seeded({ data, children }: { data: [QueryKey, unknown][]; children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the raw project document never lets a person remove or change who the project is", () => {
  it("draws $schema, version, project.id and project.slug with no remove control and no input", () => {
    render(<DocumentFields document={DOC} placed={new Map()} canEdit onSet={() => {}} />);
    for (const at of ["/$schema", "/version", "/project/id", "/project/slug", "/project"]) {
      expect(screen.queryByRole("button", { name: `Remove ${at}` }), `a remove control on ${at}`).toBeNull();
    }
    for (const at of ["/$schema", "/version", "/project/id", "/project/slug"]) {
      expect(screen.queryByRole("textbox", { name: at }), `an input on ${at}`).toBeNull();
    }
    expect(screen.getByRole("textbox", { name: "/project/name" })).toBeTruthy();
  });

  it("refuses, by the key's name, a JSON edit that changes project.id, and writes nothing", () => {
    fakeCore(() => undefined);
    function Editor() {
      const write = useWriteProjectDocument(P);
      return <DocumentEditor title="Project document" read={READ} template={DOC} canEdit write={write} onReload={() => {}} />;
    }
    render(
      <Seeded data={[]}>
        <Editor />
      </Seeded>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const box = screen.getByRole("textbox", { name: "Project document (JSON)" });
    fireEvent.change(box, { target: { value: JSON.stringify({ ...DOC, project: { ...DOC.project, id: "22222222-2222-4222-8222-222222222222" } }) } });
    expect(screen.getByText(/project\.id is fixed/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const readiness = (over: Partial<ReleaseReadiness> = {}): ReleaseReadiness => ({
  hasReleaseGate: true,
  defaultBranch: "dev",
  production: { environment: "prod", deploysFrom: null, bindingId: "b1", trigger: "on-land" },
  promotions: [],
  targetUndeclared: false,
  targetUndeclaredReason: null,
  providers: ["coolify"],
  releaseRunnerLabel: null,
  rollback: null,
  rollbackMode: null,
  hasVerify: true,
  verifySources: ["environment"],
  declarationRead: true,
  channelsRead: true,
  blockers: [{ code: "RELEASE_ROSTER_EMPTY", message: "Nothing is waiting at the release gate, so there is no release to cut.", evaluated: true }],
  warnings: [],
  gates: [
    {
      code: "RELEASE_ROSTER_EMPTY",
      kind: "blocker",
      title: "Nothing at the gate",
      sentence: "No issue is waiting at the release gate, so there is nothing to cut.",
      detail: "Nothing is waiting at the release gate, so there is no release to cut.",
      issues: [],
      owner: { kind: "agent", who: "Master", act: "bring an issue to the release gate" },
    },
  ],
  gaps: [],
  ...over,
} as ReleaseReadiness);

describe("release state reads as a state, not an alarm", () => {
  it("draws an empty roster as a neutral line in words, with no code on the page", () => {
    render(
      <Seeded data={[[["project", P, "release-readiness"], readiness()]]}>
        <ReleaseSection projectId={P} slug="hop" />
      </Seeded>,
    );
    expect(screen.queryByText(/RELEASE_ROSTER_EMPTY/), "the raw code is shown as text").toBeNull();
    const line = screen.getByText(/No issue is waiting at the release gate/).closest("[data-code]");
    expect(line?.getAttribute("data-tone"), "the empty roster is drawn with a problem's severity").toBe("state");
  });

  it("keeps a real problem's severity", () => {
    const gates = [
      {
        code: "RELEASE_POOL_EMPTY",
        kind: "blocker",
        title: "No runner paired",
        sentence: "No runner is paired to this project, so no machine can run a release.",
        detail: "x",
        issues: [],
        owner: { kind: "person", who: "A project admin", act: "pair a runner" },
      },
    ];
    render(
      <Seeded data={[[["project", P, "release-readiness"], readiness({ gates } as Partial<ReleaseReadiness>)]]}>
        <ReleaseSection projectId={P} slug="hop" />
      </Seeded>,
    );
    const line = screen.getByText(/No runner is paired/).closest("[data-code]");
    expect(line?.getAttribute("data-tone")).toBe("problem");
  });

  it("offers an in-page editor for owed knowledge, never an API path or CLI", () => {
    const calls = fakeCore((c) => (c.method === "PUT" ? { body: { id: "k", slug: "build-commands", degraded: false, truncated: false } } : undefined));
    render(
      <Seeded data={[[["project", P, "release-readiness"], readiness({ gaps: ["build-commands"] })]]}>
        <ReleaseSection projectId={P} slug="hop" />
      </Seeded>,
    );
    expect(screen.queryByText(/PUT \/api|forge knowledge write/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Write build commands" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Build commands" }), { target: { value: "pnpm build" } });
    fireEvent.click(screen.getByRole("button", { name: "Save build commands" }));
    return waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.path).toBe(`/projects/${P}/knowledge/build-commands`);
      expect(put?.body).toMatchObject({ body: "pnpm build", authoredBy: "human" });
    });
  });
});

const LIST = [{ id: P, slug: "hop", name: "Hop", orgId: "o1", orgName: "Acme", orgIsPersonal: false, createdBy: "u1", role: "admin", orgRole: "owner", archivedAt: null, createdAt: "2026-10-01T00:00:00Z" }];
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], devicePool: [], agentConfig: {}, archivedAt: null };

const screenData = (): [QueryKey, unknown][] => [
  [["projects", "all"], LIST],
  [["project", P], DETAIL],
  [["project", P, "config"], READ],
  [["project", P, "policy"], { declared: false, revision: null, document: null }],
  [["project", P, "bindings"], { bindings: [], unrepresentable: [], returned: 0 }],
  [["project", P, "release-readiness"], readiness()],
  [["project", P, "content-language"], { contentLanguage: "en", keepTermsInEnglish: [], revision: 6 }],
];

describe("settings are fields a person changes where they are shown", () => {
  it("an old tab link lands on its section", async () => {
    window.history.replaceState(null, "", "/projects/hop/settings?tab=repo");
    fakeCore(() => ({ hang: true }));
    render(
      <Seeded data={screenData()}>
        <ProjectSettingsScreen slug="hop" />
      </Seeded>,
    );
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("delivery"));
  });

  it("the default branch saves through the project document write, at the revision read", async () => {
    window.history.replaceState(null, "", "/projects/hop/settings?tab=delivery");
    const calls = fakeCore((c) =>
      c.method === "PUT" && c.path === `/projects/${P}/config`
        ? { body: { declared: true, revision: 7, document: (c.body as { document: unknown }).document, created: false } }
        : { hang: true },
    );
    render(
      <Seeded data={screenData()}>
        <ProjectSettingsScreen slug="hop" />
      </Seeded>,
    );
    const branch = await screen.findByRole("textbox", { name: "Default branch" });
    fireEvent.change(branch, { target: { value: "main" } });
    const bar = screen.getByTestId("save-bar");
    await act(async () => {
      fireEvent.click(within(bar).getByRole("button", { name: "Save changes" }));
    });
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.path).toBe(`/projects/${P}/config`);
      expect(put?.body).toMatchObject({ baseRevision: 6, document: { project: DOC.project, source: { git: { defaultBranch: "main", branches: ["dev", "main"] } } } });
    });
  });
});
