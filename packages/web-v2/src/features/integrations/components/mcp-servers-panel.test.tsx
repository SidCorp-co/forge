// @vitest-environment jsdom
//
// ISS-1038 — the panel is the whole point of this issue: it is where an
// operator learns that a green integration reaches no agent, and it is the only
// place in the product that changes it.
//
// The API module is mocked and the react-query hooks are REAL, so the in-flight
// and failure behaviour under test is the behaviour that ships rather than a
// stub of it.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpInjectionStateResponse } from "@forge/contracts";
import { McpServersPanel } from "./mcp-servers-panel";

expect.extend(matchers);

const PROJECT = "p-1";

function providerState(over: Partial<McpInjectionStateResponse["providers"][number]> = {}) {
  return {
    provider: "epodsystem" as const,
    declaredDefault: false,
    declaredStates: [] as string[],
    excludedStates: [] as string[],
    configured: true,
    ...over,
  };
}

let injectionResponse: McpInjectionStateResponse;
let previewServers: unknown[];
const setMcpInjection = vi.fn();

vi.mock("../api", () => ({
  integrationsApi: {
    mcpInjection: async () => injectionResponse,
    mcpPreview: async () => ({ servers: previewServers }),
    setMcpInjection: (projectId: string, provider: string, body: { enabled: boolean }) =>
      setMcpInjection(projectId, provider, body),
    test: async () => ({ status: "ok" }),
  },
  integrationConnectionsApi: {},
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../../orgs/hooks", () => ({ useOrgs: () => ({ data: undefined }) }));
vi.mock("../../projects/hooks", () => ({ useProjects: () => ({ data: undefined }) }));

beforeEach(() => {
  setMcpInjection.mockReset();
  setMcpInjection.mockImplementation(async () => injectionResponse);
  injectionResponse = { providers: [providerState()], canEdit: true };
  previewServers = [
    {
      provider: "epodsystem",
      serverName: "epodsystem",
      bindingId: "b-1",
      environment: "prod",
      configured: true,
      active: true,
      willInject: false,
      reason: "not_declared",
      url: "https://epod.example/mcp",
      headers: null,
      lastHealthStatus: "ok",
      lastHealthAt: null,
    },
  ];
});
afterEach(cleanup);

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <McpServersPanel projectId={PROJECT} />
    </QueryClientProvider>,
  );
}

// The design-system Toggle is a <button role="switch" aria-checked>, not a
// checkbox — so "is it on" is the aria state and "can I press it" is the
// disabled attribute.
const toggleFor = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;
const isOn = (label: string) => toggleFor(label).getAttribute("aria-checked") === "true";
const isLocked = (label: string) => toggleFor(label).disabled === true;
const EPOD_TOGGLE = "Inject Epodsystem into this project's agents";

describe("McpServersPanel — the switch (ISS-1038)", () => {
  it("offers a control for each provider the dispatcher resolves", async () => {
    injectionResponse = {
      providers: [
        providerState({ provider: "postman" }),
        providerState({ provider: "epodsystem" }),
        providerState({ provider: "sentry" }),
      ],
      canEdit: true,
    };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Inject Postman into this project's agents")).toBeTruthy();
    });
    expect(screen.getByLabelText(EPOD_TOGGLE)).toBeTruthy();
    expect(screen.getByLabelText("Inject Sentry into this project's agents")).toBeTruthy();
  });

  it("turning it on sends exactly one write, for that provider, with enabled true", async () => {
    renderPanel();
    await waitFor(() => expect(toggleFor(EPOD_TOGGLE)).toBeTruthy());
    fireEvent.click(toggleFor(EPOD_TOGGLE));
    await waitFor(() => expect(setMcpInjection).toHaveBeenCalledTimes(1));
    expect(setMcpInjection).toHaveBeenCalledWith(PROJECT, "epodsystem", { enabled: true });
  });

  it("turning it off sends enabled false", async () => {
    injectionResponse = { providers: [providerState({ declaredDefault: true })], canEdit: true };
    renderPanel();
    await waitFor(() => expect(toggleFor(EPOD_TOGGLE)).toBeTruthy());
    fireEvent.click(toggleFor(EPOD_TOGGLE));
    await waitFor(() => expect(setMcpInjection).toHaveBeenCalledTimes(1));
    expect(setMcpInjection).toHaveBeenCalledWith(PROJECT, "epodsystem", { enabled: false });
  });

  it("refuses a second write while one is in flight, and says it is busy", async () => {
    let release: ((v: McpInjectionStateResponse) => void) | null = null;
    setMcpInjection.mockImplementation(
      () =>
        new Promise<McpInjectionStateResponse>((resolve) => {
          release = resolve;
        }),
    );
    renderPanel();
    await waitFor(() => expect(toggleFor(EPOD_TOGGLE)).toBeTruthy());

    fireEvent.click(toggleFor(EPOD_TOGGLE));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Saving/));

    // The second attempt must not reach the server: two writes racing would
    // leave the panel settled on whichever response came back last.
    fireEvent.click(toggleFor(EPOD_TOGGLE));
    expect(setMcpInjection).toHaveBeenCalledTimes(1);
    expect(isLocked(EPOD_TOGGLE)).toBe(true);

    release?.({ providers: [providerState({ declaredDefault: true })], canEdit: true });
    await waitFor(() => expect(isOn(EPOD_TOGGLE)).toBe(true));
  });

  it("a failed write leaves the confirmed state, shows the failure, and retries", async () => {
    setMcpInjection.mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    await waitFor(() => expect(toggleFor(EPOD_TOGGLE)).toBeTruthy());
    expect(isOn(EPOD_TOGGLE)).toBe(false);

    fireEvent.click(toggleFor(EPOD_TOGGLE));
    await waitFor(() => expect(screen.getByText(/Could not change it/)).toBeTruthy());
    // The control did NOT move: the server never confirmed it.
    expect(isOn(EPOD_TOGGLE)).toBe(false);

    setMcpInjection.mockResolvedValueOnce({
      providers: [providerState({ declaredDefault: true })],
      canEdit: true,
    });
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(isOn(EPOD_TOGGLE)).toBe(true));
    expect(screen.queryByText(/Could not change it/)).toBeNull();
  });

  it("shows a member who cannot edit the same state, with the control disabled", async () => {
    injectionResponse = {
      providers: [providerState({ declaredDefault: true, declaredStates: ["testing"] })],
      canEdit: false,
    };
    renderPanel();
    await waitFor(() => expect(toggleFor(EPOD_TOGGLE)).toBeTruthy());
    // Present and truthful, not hidden: a member has to be able to see why.
    expect(isLocked(EPOD_TOGGLE)).toBe(true);
    expect(isOn(EPOD_TOGGLE)).toBe(true);
    expect(screen.getByText(/needs org owner or admin/)).toBeTruthy();
    expect(screen.getByText(/testing/)).toBeTruthy();
  });
});

describe("McpServersPanel — what it says about scope (ISS-1038)", () => {
  it("names the stages that declare the sentinel themselves", async () => {
    injectionResponse = {
      providers: [providerState({ declaredStates: ["testing", "in_progress"] })],
      canEdit: true,
    };
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/Also declared by these stages/)).toHaveTextContent(
        /testing, in_progress/,
      ),
    );
  });

  it("names the stages that turn the project default back off", async () => {
    injectionResponse = {
      providers: [providerState({ declaredDefault: true, excludedStates: ["open"] })],
      canEdit: true,
    };
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/Turned back off for these stages/)).toHaveTextContent(/open/),
    );
  });

  it("says a resident master's pane reads the project default, which no stage override changes", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/resident master/)).toHaveTextContent(/no issue status/),
    );
  });

  it("tells an undeclared but connected binding why it reaches nothing, and where the switch is", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/reaches no agent/)).toBeTruthy());
    // The old hint sent the operator to hand-edit a map no screen exposed.
    expect(screen.queryByText(/Add `<serverName>: true`/)).toBeNull();
  });
});
