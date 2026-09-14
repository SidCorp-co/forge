// @vitest-environment jsdom
//
// ISS-1011 — the roster, and the two ways in and out of it.
//
// An agent and a person hold different authority and see different data, so the
// two rows have to be told apart at a glance rather than on inspection. That is
// asserted twice here: once as a structural difference the DOM carries, and once
// as the contrast the outline actually has, computed from the token file rather
// than judged by eye — a "different" border nobody can see is not a difference.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMembership } from "../types";

expect.extend(matchers);

const candidates = vi.fn();
const addPerson = vi.fn();
const addHandle = vi.fn();
const removeParticipant = vi.fn();

vi.mock("../api", () => ({
  conversationsApi: {
    candidates: (...a: unknown[]) => candidates(...a),
    candidatesForProject: (...a: unknown[]) => candidates(...a),
    addPerson: (...a: unknown[]) => addPerson(...a),
    addHandle: (...a: unknown[]) => addHandle(...a),
    removeParticipant: (...a: unknown[]) => removeParticipant(...a),
  },
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConversationMembers } = await import("./conversation-members");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const alpha = { id: "p1", name: "Alpha", slug: "alpha" };
const room: ConversationMembership = {
  shape: "direct",
  scope: [alpha.id],
  scopeProjects: [alpha],
  participants: [
    {
      id: "a1",
      kind: "handle",
      userId: "ua1",
      projectId: alpha.id,
      label: "alpha",
      displayName: "alpha",
      reachable: true,
    },
    {
      id: "pp1",
      kind: "person",
      userId: "u1",
      projectId: null,
      label: null,
      displayName: "Ada",
      reachable: null,
    },
  ],
};

function mount(canChange = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationMembers
        conversationId="c1"
        room={room}
        canChange={canChange}
        open
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("the roster", () => {
  it("lists everyone in the room", () => {
    mount();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("@alpha")).toBeInTheDocument();
  });

  it("labels each member as a person or as an agent", () => {
    mount();
    expect(screen.getByTestId("member-row-agent")).toBeInTheDocument();
    expect(screen.getByTestId("member-row-person")).toBeInTheDocument();
    expect(screen.getByTestId("member-row-person")).toHaveTextContent("Person");
    expect(screen.getByTestId("member-row-agent")).toHaveTextContent("Alpha");
  });

  it("gives an agent's row an outline and a fill a person's row does not have", () => {
    mount();
    const agentRow = screen.getByTestId("member-row-agent").className;
    const personRow = screen.getByTestId("member-row-person").className;
    expect(agentRow).toContain("border-[color:var(--accent)]");
    expect(agentRow).toContain("bg-[color:var(--accent-tint)]");
    expect(personRow).toContain("border-transparent");
    expect(personRow).not.toContain("var(--accent-tint)");
  });

  it("gives an agent's row a different glyph from a person's", () => {
    mount();
    // cm:guard the marks are compared and not the whole row, because the remove control carries an icon of its own: a count over the row would be a test about the button beside the glyph.
    const agentMark = screen.getByTestId("member-mark-agent");
    const personMark = screen.getByTestId("member-mark-person");
    expect(agentMark.querySelectorAll("svg").length).toBeGreaterThan(0);
    // cm:guard the person's mark is an AVATAR — initials in a tinted pill, not an icon — so the two are different shapes and not one icon set with two names in it.
    expect(personMark.querySelectorAll("svg").length).toBe(0);
    expect(personMark).toHaveTextContent("A");
  });

  it("offers adding an agent and adding a person as two separate controls", () => {
    mount();
    const agent = screen.getByRole("button", { name: /add agent/i });
    const person = screen.getByRole("button", { name: /add person/i });
    expect(agent).not.toBe(person);
  });

  it("offers neither to somebody who may not change the room", () => {
    mount(false);
    expect(screen.queryByRole("button", { name: /add agent/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add person/i })).toBeNull();
  });

  it("says where the room's projects come from", () => {
    mount();
    expect(screen.getByTestId("members-scope-derivation")).toHaveTextContent(
      /Read from the agents in this room/i,
    );
  });
});

describe("a removal the server refuses", () => {
  it("is reported on the roster, and the member stays in the list", async () => {
    removeParticipant.mockRejectedValue(
      new Error("this is the last handle; delete the conversation instead"),
    );
    mount();
    fireEvent.click(screen.getByLabelText(/Take alpha out of the room/i));
    await waitFor(() => expect(screen.getByTestId("members-remove-error")).toBeInTheDocument());
    expect(screen.getByTestId("members-remove-error")).toHaveTextContent(/last handle/i);
    expect(screen.getByTestId("member-row-agent")).toBeInTheDocument();
    expect(screen.getByText("@alpha")).toBeInTheDocument();
  });
});

describe("the add-an-agent dialogue", () => {
  const openAgentDialog = async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
  };

  it("says a candidate list is still loading", async () => {
    candidates.mockReturnValue(new Promise(() => undefined));
    await openAgentDialog();
    await waitFor(() =>
      expect(screen.getByTestId("agent-candidates-loading")).toBeInTheDocument(),
    );
  });

  it("says a candidate list is empty", async () => {
    candidates.mockResolvedValue({ people: [], handles: [] });
    await openAgentDialog();
    await waitFor(() => expect(screen.getByTestId("agent-candidates-empty")).toBeInTheDocument());
  });

  it("says a candidate list failed, and offers a way to try again", async () => {
    candidates.mockRejectedValue(new Error("the directory could not be reached"));
    await openAgentDialog();
    await waitFor(() => expect(screen.getByTestId("agent-candidates-error")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
  });

  it("keeps the dialogue and the selection when the add is refused", async () => {
    candidates.mockResolvedValue({
      people: [],
      handles: [{ userId: "ub", handle: "beta", project: { id: "p2", name: "Beta", slug: "beta" } }],
    });
    addHandle.mockRejectedValue(new Error("you hold viewer on project Beta"));
    await openAgentDialog();
    await waitFor(() => expect(screen.getByText("@beta")).toBeInTheDocument());
    fireEvent.click(screen.getByText("@beta"));
    await waitFor(() =>
      expect(screen.getByTestId("add-agent-confirmation")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Add @beta/i }));
    await waitFor(() => expect(screen.getByTestId("add-agent-error")).toBeInTheDocument());
    expect(screen.getByTestId("add-agent-error")).toHaveTextContent(/viewer on project Beta/i);
    expect(screen.getByTestId("add-agent-confirmation")).toBeInTheDocument();
  });

  it("cannot be submitted twice while the first add is in flight", async () => {
    candidates.mockResolvedValue({
      people: [],
      handles: [{ userId: "ub", handle: "beta", project: { id: "p2", name: "Beta", slug: "beta" } }],
    });
    addHandle.mockReturnValue(new Promise(() => undefined));
    await openAgentDialog();
    await waitFor(() => expect(screen.getByText("@beta")).toBeInTheDocument());
    fireEvent.click(screen.getByText("@beta"));
    await waitFor(() => expect(screen.getByTestId("add-agent-confirmation")).toBeInTheDocument());
    const submit = screen.getByRole("button", { name: /Add @beta/i });
    fireEvent.click(submit);
    await waitFor(() => expect(addHandle).toHaveBeenCalledTimes(1));
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(addHandle).toHaveBeenCalledTimes(1);
  });
});

/**
 * The outline an agent's row is given, measured rather than described.
 */
// cm:guard read out of the token FILE and not out of jsdom, which resolves no custom property and would report every one of them as the empty string — a test asserting on that computes a contrast of 1 and passes whatever the palette says. The bar is the 3:1 non-text one, which is what makes "at a glance" a number rather than an opinion (ISS-1011 criterion 3).
describe("the agent outline, measured", () => {
  const tokens = readFileSync(
    join(process.cwd(), "src/styles/tokens.css"),
    "utf8",
  );
  const tokenValue = (name: string): string => {
    const direct = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens);
    if (direct?.[1]) return direct[1];
    const alias = new RegExp(`--${name}:\\s*var\\(--([a-z0-9-]+)\\)`).exec(tokens);
    if (alias?.[1]) return tokenValue(alias[1]);
    throw new Error(`no token --${name} in tokens.css`);
  };
  const luminance = (hex: string): number => {
    const parts = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number);
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
    return (x + 0.05) / (y + 0.05);
  };

  it("clears the 3:1 non-text bar against both grounds it is drawn on", () => {
    const accent = tokenValue("accent");
    expect(ratio(accent, tokenValue("bg-surface"))).toBeGreaterThanOrEqual(3);
    expect(ratio(accent, tokenValue("bg-app"))).toBeGreaterThanOrEqual(3);
  });
});
