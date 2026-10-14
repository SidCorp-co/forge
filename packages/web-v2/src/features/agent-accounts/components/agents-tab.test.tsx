// @vitest-environment jsdom
//
// ISS-1169: the agents table says what is different about each agent and nothing it says of all of them.
// Thirteen agents, eleven of which cannot act, is the account the audit measured: the explanation is on
// the page once, no row carries a control it cannot use, and no cell prints an identifier.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccountRow } from "../types";

expect.extend(matchers);

const REMOVED_ID = "7dca1ad6-ab90-443f-a188-98f3e770265b";
const state: { agents: AgentAccountRow[]; projects: { id: string; name: string }[] | undefined } = {
  agents: [],
  projects: [],
};
const mintMutate = vi.fn(async () => ({ plaintext: "forge_pat_secret" }));
const revokeMutate = vi.fn(async () => ({ revoked: 1 }));

vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: { id: "o1", name: "Acme", role: "admin" } }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: state.projects, isLoading: state.projects === undefined }),
  useOrgScopedProjects: () => ({ projects: state.projects ?? [], isLoading: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../hooks", () => ({
  useAgentAccounts: () => ({ data: state.agents, isLoading: false, isError: false }),
  useMintAgentCredential: () => ({ mutateAsync: mintMutate, isPending: false }),
  useRevokeAgentCredentials: () => ({ mutateAsync: revokeMutate, isPending: false }),
  useSetAgentDisplayName: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateAgent: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("./agent-self-editor", () => ({ AgentSelfEditor: () => <p>self editor</p> }));

import { AgentsTab } from "./agents-tab";

function agent(n: number, over: Partial<AgentAccountRow> = {}): AgentAccountRow {
  return {
    userId: `u${n}`,
    handle: `agent-${n}`,
    displayName: null,
    email: `a${n}@x`,
    projects: [{ id: "p1", role: "member" }],
    createdAt: "2026-09-01T00:00:00Z",
    activeTokens: 0,
    canAct: false,
    ...over,
  };
}

beforeEach(() => {
  // 11 agents holding no credential, one that can act, and one whose project id resolves to nothing.
  state.agents = [
    ...Array.from({ length: 11 }, (_, i) => agent(i)),
    agent(11, { activeTokens: 1, canAct: true }),
    agent(12, { projects: [{ id: REMOVED_ID, role: "member" }], activeTokens: 1, canAct: true }),
  ];
  state.projects = [{ id: "p1", name: "alpha" }];
  mintMutate.mockClear();
  revokeMutate.mockClear();
});
afterEach(cleanup);

const table = () => screen.getByRole("table", { name: "Agents" });
const rows = () => within(table()).getAllByRole("row").slice(1);

describe("AgentsTab — what is said once", () => {
  it("writes the credential explanation once, above the table, and in no row", () => {
    render(<AgentsTab />);
    expect(screen.getAllByText(/without one it cannot answer in a room/)).toHaveLength(1);
    expect(within(table()).queryByText(/cannot answer in a room/)).toBeNull();
    expect(within(table()).queryByText(/Give it a credential/)).toBeNull();
  });

  it("says above the table that giving a credential adds one and does not replace", () => {
    render(<AgentsTab />);
    expect(screen.getByText(/adds one and does not replace the one an agent already holds/)).toBeInTheDocument();
  });

  it("gives a Can act cell only Yes or a short No with its reason", () => {
    render(<AgentsTab />);
    const cells = rows().map((tr) => within(tr).getAllByRole("cell")[3]?.textContent);
    expect(cells.filter((c) => c === "No — holds no live credential")).toHaveLength(11);
    expect(cells.filter((c) => c === "Yes")).toHaveLength(2);
  });

  it("names the action to issue a credential the same on every row, whether or not the agent holds one", () => {
    render(<AgentsTab />);
    expect(screen.getAllByRole("button", { name: /^Give a credential/ })).toHaveLength(13);
    expect(screen.queryByText(/Mint another/)).toBeNull();
  });
});

describe("AgentsTab — a row carries only the controls it can use", () => {
  it("renders no Revoke on an agent that holds no live credential, and an enabled one on an agent that does", () => {
    render(<AgentsTab />);
    const revokes = screen.getAllByRole("button", { name: /^Revoke/ });
    expect(revokes).toHaveLength(2);
    for (const b of revokes) expect(b).toBeEnabled();
    for (const tr of rows().slice(0, 11)) expect(within(tr).queryByRole("button", { name: /^Revoke/ })).toBeNull();
  });

  it("renders no disabled control in any row", () => {
    render(<AgentsTab />);
    for (const b of within(table()).getAllByRole("button")) expect(b).toBeEnabled();
  });

  it("asks first, naming the agent, and revokes the one whose Revoke was pressed only once confirmed", () => {
    render(<AgentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke, agent-11" }));
    expect(screen.getByText('Revoke the credentials of "agent-11"?')).toBeInTheDocument();
    expect(revokeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revokeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke, agent-11" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke credentials" }));
    expect(revokeMutate).toHaveBeenCalledWith("u11");
  });
});

describe("AgentsTab — an identifier is never a display value", () => {
  it("names the project it can, and says so when one cannot be resolved instead of printing its id", () => {
    render(<AgentsTab />);
    const last = rows()[12] as HTMLElement;
    expect(within(last).getByText("1 project removed or not shared with you")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(REMOVED_ID);
    expect(within(rows()[0] as HTMLElement).getByText("alpha")).toBeInTheDocument();
  });

  it("says projects are loading while the names are not known, rather than calling them removed", () => {
    state.projects = undefined;
    render(<AgentsTab />);
    expect(within(rows()[0] as HTMLElement).getByText("Loading projects…")).toBeInTheDocument();
    expect(screen.queryByText(/removed or not shared/)).toBeNull();
  });
});

describe("AgentsTab — the shared table", () => {
  it("sorts from its headers, and holds the Name column at the start edge", () => {
    render(<AgentsTab />);
    const name = within(table()).getByRole("columnheader", { name: /Name/ });
    expect(name).toHaveClass("sticky");
    fireEvent.click(within(name).getByRole("button"));
    fireEvent.click(within(name).getByRole("button"));
    expect(name).toHaveAttribute("aria-sort", "descending");
    expect(within(rows()[0] as HTMLElement).getByRole("button", { name: "agent-9" })).toBeInTheDocument();
  });

  it("opens the self editor under the table from a row's Edit self action, which says what it opens", () => {
    render(<AgentsTab />);
    expect(screen.queryByRole("button", { name: /^Self,/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit self, agent-0" }));
    expect(screen.getByText("self editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close editor, agent-0" })).toHaveAttribute("aria-expanded", "true");
  });

  it("names each row's own agent on its button, so no two buttons read alike", () => {
    render(<AgentsTab />);
    const names = screen.getAllByRole("button", { name: /^Edit self, / }).map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(1);
  });
});

describe("AgentsTab — the New agent form sits below the table", () => {
  it("points an empty list at the form below it", () => {
    state.agents = [];
    render(<AgentsTab />);
    expect(screen.getByText(/Create one below/)).toBeInTheDocument();
  });

  it("is reached after the table, with the project picker collapsed to a search", () => {
    state.projects = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, name: `project-${i}` }));
    render(<AgentsTab />);
    const form = screen.getByText("New agent");
    expect(table().compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search projects" })).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create agent" })).toBeInTheDocument();
  });
});
