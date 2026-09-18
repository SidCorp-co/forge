// @vitest-environment jsdom
//
// ISS-1034 criterion 51 — the org agents tab carries a self editor per agent,
// and what it sends is the patch the server's key-by-key presence merge expects.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSelf } from "@forge/contracts";
import { AgentSelfEditor, patchOf } from "./agent-self-editor";

expect.extend(matchers);

const save = vi.fn(async () => ({}));
const refetch = vi.fn();
let self: AgentSelf;
let failed: Error | null = null;
vi.mock("../hooks", () => ({
  useAgentSelf: () =>
    failed
      ? { data: undefined, isLoading: false, isError: true, error: failed, refetch }
      : { data: self, isLoading: false, isError: false, refetch },
  useUpdateAgentSelf: () => ({ mutateAsync: save, isPending: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

beforeEach(() => {
  save.mockClear();
  refetch.mockClear();
  failed = null;
  self = {
    userId: "agent-1",
    soul: "I am Babo, the Alpha project's assistant.",
    instructions: null,
    emoji: "🦉",
    greeting: null,
    presence: { answerInGroup: "mention", heartbeat: { enabled: true, intervalMs: 1_800_000 } },
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  };
});
afterEach(cleanup);

const renderEditor = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentSelfEditor orgId="org-1" agentUserId="agent-1" handle="babo" />
    </QueryClientProvider>,
  );

describe("the agent self editor (criterion 51)", () => {
  // ISS-1087 criterion 33 — the third group mode renders from the stored self, so the select must offer it.
  it("offers tool as a third group mode", () => {
    self = { ...self, presence: { answerInGroup: "tool" } };
    renderEditor();
    expect(screen.getByLabelText("In a group room")).toHaveTextContent(/only when it chooses/i);
  });

  it("shows the stored self and presence in human units", () => {
    renderEditor();
    expect(screen.getByLabelText("Soul")).toHaveValue("I am Babo, the Alpha project's assistant.");
    expect(screen.getByLabelText("Glyph")).toHaveValue("🦉");
    expect(screen.getByLabelText("In a group room")).toHaveTextContent(/only when named/i);
    expect(screen.getByLabelText("Heartbeat")).toHaveTextContent(/^on$/i);
    expect(screen.getByLabelText("Heartbeat interval (minutes)")).toHaveValue("30");
    expect(screen.getByLabelText("Back off after quiet windows")).toHaveValue("");
  });

  it("saves the whole self, presence keys one by one, in server units", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Back off after quiet windows"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Heartbeat interval (minutes)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save self/i }));
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith({
      agentUserId: "agent-1",
      patch: {
        soul: "I am Babo, the Alpha project's assistant.",
        instructions: null,
        greeting: null,
        emoji: "🦉",
        presence: {
          answerInGroup: "mention",
          heartbeat: { enabled: true, intervalMs: null },
          backoffAfter: 1,
          dormantMs: null,
        },
      },
    });
  });
});

describe("a first read that fails (codex F6)", () => {
  it("shows the refusal and a retry, not a skeleton", () => {
    failed = new Error("org admin required");
    renderEditor();
    expect(screen.getByTestId("agent-self-error-agent-1")).toHaveTextContent(/org admin required/);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Soul")).toBeNull();
  });
});

describe("patchOf", () => {
  // cm:guard an emptied number goes out as NULL, which the server reads as "unset this key, fold the default back": sending 0 would be a real value the bounds refuse, and omitting the key would leave a stale value standing (ISS-1034 criterion 51).
  it("sends an emptied number as null and a set one scaled to server units", () => {
    const patch = patchOf({
      soul: "",
      instructions: "always cite the issue",
      greeting: "",
      emoji: "",
      answerInGroup: "window",
      heartbeat: false,
      heartbeatMinutes: "5",
      backoffAfter: "",
      dormantHours: "2",
    });
    expect(patch).toEqual({
      soul: null,
      instructions: "always cite the issue",
      greeting: null,
      emoji: null,
      presence: {
        answerInGroup: "window",
        heartbeat: { enabled: false, intervalMs: 300_000 },
        backoffAfter: null,
        dormantMs: 7_200_000,
      },
    });
  });
});
