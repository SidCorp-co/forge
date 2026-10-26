// @vitest-environment jsdom
//
// ISS-1421 r8, criterion 128 — judge-40 saw the Coolify and Postman drawers show "Agents on this
// project may use this" twice: once in the provider's own section, once more from the drawer.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { LeaveGuardProvider } from "@/design";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_MODULES } from "../providers/registry";
import { GRANT_LABEL } from "./agent-access-control";
import { BindingsList, ConnectionDetailDrawer } from "./connection-detail-drawer";
import { ALL_ACTS, ALL_MAY } from "../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const NOW = "2026-10-14T00:00:00.000Z";

let provider = "coolify";
let served: string[] = [];
/** The providers whose binding here is a deploy binding; the others are service bindings. */
let deployTo: string[] = ["coolify"];
/** What core answers the reader about each binding and the tab: everything, unless a test narrows it. */
let acts = ALL_ACTS;
let may = ALL_MAY;
/** The reader's connections, as the Integrations page lists them. */
let connections: unknown[] = [];
/** The Coolify applications each stage's binding deploys, where a test names them. */
let appsOf: Partial<Record<"preview" | "live", string>> = {};

function binding(stage: "preview" | "live") {
  return {
    id: `${CONNECTION}-${stage}`,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider,
    role: deployTo.includes(provider) ? "deploy" : "service",
    stages: deployTo.includes(provider) ? [stage] : [],
    config: { baseUrl: "https://stub.example.com", host: "https://sentry.example.com" },
    bindingConfig: appsOf[stage] ? { targets: [{ id: "web", label: "Web", resourceUuid: appsOf[stage] }] } : {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: "ok",
    lastHealthAt: NOW,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "off",
    agentPathKind: "core-mediated",
    acts,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const PROJECT_ROW = {
  id: PROJECT,
  slug: "stub",
  name: "Stub",
  orgId: "63b1b3a0-1f0e-4a77-9f2d-2c5e6a7b8c90",
  orgName: "Stub org",
  orgIsPersonal: false,
  orgRole: "owner",
  role: "owner",
};

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    apiClient: async (path: string) => {
      const bare = path.split("?")[0] ?? path;
      served.push(bare);
      if (bare === `/projects/${PROJECT}/integrations`) {
        // One binding per provider, as a drawer opened from one row shows; Coolify's two are its stages.
        return { items: provider === "coolify" ? [binding("preview"), binding("live")] : [binding("live")], may };
      }
      if (bare === "/integration-connections") return { items: connections };
      if (bare === "/projects") return [PROJECT_ROW];
      if (bare === `/projects/${PROJECT}`) return { ...PROJECT_ROW, agentConfig: {} };
      return { items: [], bindings: [], applications: [], rooms: [], targets: [], repositories: [], truncated: false };
    },
  };
});
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: [] }),
  useProjects: () => ({ data: [PROJECT_ROW] }),
  useProject: () => ({ data: PROJECT_ROW }),
  useUpdateProject: () => ({ mutate: () => {}, isPending: false, isError: false, error: null }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

let queries: QueryClient;

/** What the workspace layout mounts above every page, and a section holding unsaved edits needs. */
function Page({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queries}>
      <LeaveGuardProvider>{children}</LeaveGuardProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  served = [];
  deployTo = ["coolify"];
  acts = ALL_ACTS;
  may = ALL_MAY;
  connections = [];
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(cleanup);

describe("a provider's drawer shows the agents switch once", () => {
  it.each(PROVIDER_MODULES.filter((m) => m.section !== null).map((m) => m.provider))(
    "%s",
    async (name) => {
      provider = name;
      render(
        <Page>
          <ConnectionDetailDrawer
            projectId={PROJECT}
            card={{ key: name, status: "connected", meta: {} } as never}
            onClose={() => {}}
          />
        </Page>,
      );
      // The section is lazy: count only once its Suspense fallback is gone and every read answered,
      // or a switch the pane draws first is counted before the section's own arrives.
      await waitFor(() => {
        expect(served).toContain(`/projects/${PROJECT}/integrations`);
        expect(queries.isFetching()).toBe(0);
        expect(document.querySelector(".skeleton")).toBeNull();
        expect(screen.getAllByText(GRANT_LABEL).length).toBeGreaterThan(0);
      });
      expect(screen.getAllByText(GRANT_LABEL)).toHaveLength(1);
    },
  );
});

// ISS-1421 r27, judge-108 (287, 293 and the extras): a plain member of the project was told to save a
// key and fix the base URL, and offered Save, Disconnect and a live Enabled switch, all of which core
// refused. The drawer now draws from the binding's acts, the rule core refuses by.
describe("a plain member of the project's drawer offers nothing core refuses them", () => {
  it.each(PROVIDER_MODULES.filter((m) => m.section !== null).map((m) => m.provider))(
    "%s",
    async (name) => {
      provider = name;
      acts = { ...ALL_ACTS, change: false, saveKey: false, turnOn: false, grantAgents: false };
      may = { ...ALL_MAY, connect: false, grantBoxAgents: false, changeProjectSettings: false };
      render(
        <Page>
          <ConnectionDetailDrawer
            projectId={PROJECT}
            card={{ key: name, status: "connected", meta: {} } as never}
            onClose={() => {}}
          />
        </Page>,
      );
      await waitFor(() => {
        expect(served).toContain(`/projects/${PROJECT}/integrations`);
        expect(queries.isFetching()).toBe(0);
        expect(document.querySelector(".skeleton")).toBeNull();
        expect(screen.getAllByText(GRANT_LABEL).length).toBeGreaterThan(0);
      });
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /enable credential/i })).toBeNull();
      for (const control of screen.queryAllByRole("switch")) expect(control).toBeDisabled();
      // Nothing they may not save is left editable: a field with no Save reads as one that saves.
      for (const box of screen.queryAllByRole("textbox")) expect(box, box.getAttribute("aria-label") ?? box.id).toBeDisabled();
      expect(screen.queryByText(/Enter one to store it|Saving a new key/)).toBeNull();
      // Said once: Coolify, Google Sheets and Rocket.Chat said it twice (ISS-1421 r30, 342).
      expect(
        screen.getAllByText(/^Only an admin of this project can switch this integration/),
      ).toHaveLength(1);
    },
  );
});

// ISS-1421 r27: the Coolify drawer's auto-approve writes the pipeline config, whose door needs an
// owner or admin of the organization; a project admin who is neither was offered it and refused.
describe("a project admin who does not administer the organization", () => {
  it("is not offered Coolify's auto-approve, and is told who may", async () => {
    provider = "coolify";
    may = { ...ALL_MAY, changeProjectSettings: false };
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: "coolify:live", status: "connected", meta: { capabilities: { canDeploy: true } } } as never}
          onClose={() => {}}
        />
      </Page>,
    );
    await waitFor(() => expect(screen.getByRole("switch", { name: "Auto-approve production deploys" })).toBeDisabled());
    expect(
      screen.getByText("Only an owner or admin of this project's organization can change this."),
    ).toBeInTheDocument();
  });
});

// ISS-1421 r27, judge-110 (c): a Postman connection needing sign-in showed only the badge in the
// drawer; the reason sentence was on the row, or here only after Test was pressed.
describe("a drawer opened on a row needing attention", () => {
  it("says the row's reason, from the same card", async () => {
    provider = "postman";
    const detail = "Postman needs you to sign in again before Forge can read its collections.";
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: "postman", status: "attention", configured: true, detail, meta: {} } as never}
          onClose={() => {}}
        />
      </Page>,
    );
    await waitFor(() => expect(screen.getByText(detail)).toBeInTheDocument());
  });
});

// ISS-1339 r2, judge-98: round 1 took the probe off Shape & release, and the place its gap link
// sent a person had no field for it. Every provider a release reads a probe from that has a drawer
// here is drawn with its live binding's probe; a binding that serves only Preview has none to set.
describe("a live deploy binding's drawer offers its verify probe", () => {
  function drawDrawer(name: string, stage: "preview" | "live") {
    provider = name;
    deployTo = [name];
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: `${name}:${stage}`, status: "connected", meta: { capabilities: { canDeploy: true } } } as never}
          onClose={() => {}}
        />
      </Page>,
    );
  }

  it.each(["coolify", "epodsystem"])("%s, at Live", async (name) => {
    drawDrawer(name, "live");
    await waitFor(() => {
      expect(queries.isFetching()).toBe(0);
      expect(screen.getByText("Verify probe")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Probe 1 URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Probe 1 commit field")).toBeInTheDocument();
  });

  it("not on a binding that serves only Preview", async () => {
    drawDrawer("coolify", "preview");
    await waitFor(() => {
      expect(served).toContain(`/projects/${PROJECT}/integrations`);
      expect(queries.isFetching()).toBe(0);
      expect(document.querySelector(".skeleton")).toBeNull();
    });
    expect(screen.queryByText("Verify probe")).toBeNull();
  });
});

// ISS-1339 r3, judge-99: closing the drawer dropped an unsaved probe edit without a word, and the
// Delivery log tab unmounted it the same way.
describe("an unsaved probe edit is not dropped without a word", () => {
  const CLOSE = "Discard the unsaved probe?";

  async function drawDirty(onClose: () => void) {
    provider = "coolify";
    deployTo = ["coolify"];
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={
            {
              key: "coolify:live",
              status: "connected",
              meta: { capabilities: { canDeploy: true, hasDeliveryLog: true } },
            } as never
          }
          onClose={onClose}
        />
      </Page>,
    );
    await waitFor(() => {
      expect(queries.isFetching()).toBe(0);
      expect(screen.getByLabelText("Probe 1 URL")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/version" } });
  }

  const drawerClose = () => screen.getAllByRole("button", { name: "Close" })[0] as HTMLElement;

  it("asks before the close button closes it, and Keep editing keeps the edit", async () => {
    const onClose = vi.fn();
    await drawDirty(onClose);
    fireEvent.click(drawerClose());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(CLOSE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText(CLOSE)).toBeNull();
    expect(screen.getByLabelText("Probe 1 URL")).toHaveValue("https://api.example.com/version");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Discard", async () => {
    const onClose = vi.fn();
    await drawDirty(onClose);
    fireEvent.click(drawerClose());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks on Escape, and an Escape in the question closes only the question", async () => {
    const onClose = vi.fn();
    await drawDirty(onClose);
    fireEvent.keyDown(screen.getByLabelText("Probe 1 URL"), { key: "Escape" });
    expect(screen.getByText(CLOSE)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep editing" }), { key: "Escape" });
    expect(screen.queryByText(CLOSE)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Probe 1 URL")).toHaveValue("https://api.example.com/version");
  });

  it("asks on a click on the backdrop", async () => {
    const onClose = vi.fn();
    await drawDirty(onClose);
    const backdrop = screen.getAllByRole("dialog")[0]?.parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(CLOSE)).toBeInTheDocument();
  });

  it("closes without asking once nothing is unsaved", async () => {
    const onClose = vi.fn();
    await drawDirty(onClose);
    fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "" } });
    fireEvent.click(drawerClose());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText(CLOSE)).toBeNull();
  });

  it("keeps the edit through the Delivery log tab and back", async () => {
    await drawDirty(() => {});
    fireEvent.click(screen.getByRole("tab", { name: "Delivery log" }));
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(screen.getByLabelText("Probe 1 URL")).toHaveValue("https://api.example.com/version");
  });
});

// ISS-1421 r23, judge-94 on 224: an org member's list named a project they cannot open by its id.
describe("a project's list of the projects a connection is bound to", () => {
  it("names a project the reader cannot open in words, never by its id", () => {
    const other = { ...binding("live"), id: "b-other", projectId: "9f1c2d3e-0000-4000-8000-000000000001" };
    render(
      <BindingsList
        items={[binding("live"), other] as never}
        projectNames={new Map([[PROJECT, "Stub"]])}
        projectsRead
        currentProjectId={PROJECT}
        currentStage={null}
      />,
    );
    expect(screen.getByText("Stub")).toBeInTheDocument();
    expect(screen.getByText("A project you cannot open")).toBeInTheDocument();
    expect(screen.queryByText(/9f1c2d3e/)).toBeNull();
  });
});

// ISS-1421 r30, judge-122: the live approval gate printed `integration: <uuid>` under Confirm live
// deploy, an id no reader can act on.
describe("the live approval gate", () => {
  function drawLive() {
    provider = "coolify";
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: "coolify:live", status: "connected", meta: { capabilities: { canDeploy: true } } } as never}
          onClose={() => {}}
        />
      </Page>,
    );
  }

  it("names the connection it deploys through by its name, and no id", async () => {
    connections = [
      {
        id: CONNECTION,
        provider: "coolify",
        displayName: "Production box",
        ownerType: "org",
        ownerId: PROJECT_ROW.orgId,
        config: { baseUrl: "https://stub.example.com" },
        active: true,
        hasSecrets: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    drawLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm live deploy" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Through the connection Production box.")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(CONNECTION))).toBeNull();
    expect(screen.queryByText(/^integration:/)).toBeNull();
  });

  it("tells two connections of the same name apart, as the Connections page does", async () => {
    const box = (id: string, createdAt: string) => ({
      id,
      provider: "coolify",
      displayName: "Production box",
      ownerType: "org",
      ownerId: PROJECT_ROW.orgId,
      config: { baseUrl: "https://stub.example.com" },
      active: true,
      hasSecrets: true,
      createdAt,
      updatedAt: createdAt,
    });
    connections = [box(CONNECTION, NOW), box("c2d7e8f9-0a1b-4c2d-8e3f-4a5b6c7d8e9f", "2026-10-01T00:00:00.000Z")];
    drawLive();
    await waitFor(() =>
      expect(screen.getByText("Through the connection Production box · added 14 Oct 2026.")).toBeInTheDocument(),
    );
  });

  // Review on criterion 344: core parks a preview deploy of the application a live binding also
  // deploys, so the drawer has to offer that binding the confirmation it is waiting on.
  function drawPreview() {
    provider = "coolify";
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: "coolify:preview", status: "connected", meta: { capabilities: { canDeploy: true } } } as never}
          onClose={() => {}}
        />
      </Page>,
    );
  }

  it("is offered on a preview binding that deploys the application the live one deploys", async () => {
    appsOf = { preview: "made-up-app", live: "made-up-app" };
    drawPreview();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm live deploy" })).toBeInTheDocument());
    appsOf = {};
  });

  it("is not offered on a preview binding that deploys an application of its own", async () => {
    appsOf = { preview: "made-up-preview-app", live: "made-up-app" };
    drawPreview();
    await waitFor(() => expect(screen.getByText("Agents on this project may use this")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Confirm live deploy" })).toBeNull();
    appsOf = {};
  });

  // ISS-1421 r31, judge-127: a plain member saw Confirm live deploy greyed, with nothing saying who
  // may confirm; core confirms only for an admin of the project.
  it("says who may confirm a live deploy to a reader who may not", async () => {
    acts = { ...ALL_ACTS, change: false };
    drawLive();
    await waitFor(() =>
      expect(screen.getByTestId("confirm-who")).toHaveTextContent(
        "Only an admin of this project can confirm a live deploy.",
      ),
    );
  });

  it("says nothing of who may confirm to a reader who may", async () => {
    drawLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm live deploy" })).toBeInTheDocument());
    expect(screen.queryByTestId("confirm-who")).toBeNull();
  });

  // ISS-1421 r31, judge-127: on a preview binding the gate stood with no word on why it was there.
  it("says on a preview binding why it holds that binding's deploys", async () => {
    appsOf = { preview: "made-up-app", live: "made-up-app" };
    drawPreview();
    await waitFor(() =>
      expect(screen.getByTestId("preview-gate-why")).toHaveTextContent(
        "This preview binding deploys an application a live binding deploys",
      ),
    );
    appsOf = {};
  });

  it("gives a live binding's gate no preview reason", async () => {
    drawLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm live deploy" })).toBeInTheDocument());
    expect(screen.queryByTestId("preview-gate-why")).toBeNull();
  });

  it("names it by where it points where the reader's list does not hold it", async () => {
    drawLive();
    await waitFor(() => expect(screen.getByText("Through the connection at stub.example.com.")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(CONNECTION))).toBeNull();
  });
});

// ISS-1421 r30: Rocket.Chat's bot personality example was Vietnamese; Forge is written in English.
describe("Rocket.Chat's bot personality field", () => {
  it("gives its example in English", async () => {
    provider = "rocketchat";
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: "rocketchat", status: "connected", meta: {} } as never}
          onClose={() => {}}
        />
      </Page>,
    );
    await waitFor(() => expect(screen.getByText("Bot personality")).toBeInTheDocument());
    const example = screen.getByPlaceholderText(/^e\.g\./).getAttribute("placeholder") ?? "";
    expect(example).toMatch(/^e\.g\. "[\x20-\x7E]+"$/);
  });

  // ISS-1421 r31, judge-127: the field and the room input were named by nothing but placeholders.
  it("gives the personality field and the room field accessible names", async () => {
    provider = "rocketchat";
    render(
      <Page>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: "rocketchat", status: "connected", meta: {} } as never}
          onClose={() => {}}
        />
      </Page>,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Bot personality" })).toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Room to add" })).toBeInTheDocument();
  });
});
