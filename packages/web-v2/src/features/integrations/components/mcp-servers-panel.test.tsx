// @vitest-environment jsdom
//
// ISS-1421 r5 — judge-33 found the Agent MCP servers panel titling its rows by lower-case server id
// (postman, epodsystem, sentry) under a paragraph about per-state overrides and the resolver that
// performs the injection. A person reading it is told which tools an agent gets, in their words.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerPreviewEntry } from "../types";
import { ALL_ACTS } from "../test-acts";
import {
  MCP_PANEL_INTRO,
  McpServersPanel,
  NOT_GRANTED_YET,
  REASON_HINTS,
  reasonHint,
  rowTitle,
  rowTitles,
} from "./mcp-servers-panel";

expect.extend(matchers);

const entry = (over: Partial<McpServerPreviewEntry>): McpServerPreviewEntry => ({
  source: "integration",
  provider: "postman",
  serverName: "postman",
  bindingId: null,
  role: null,
  stages: [],
  configured: false,
  active: false,
  willInject: false,
  reason: "not_configured",
  url: null,
  headers: null,
  lastHealthStatus: null,
  lastHealthAt: null,
  ...over,
});

const servers: McpServerPreviewEntry[] = [
  entry({ provider: "postman", serverName: "postman" }),
  entry({
    provider: "coolify",
    serverName: "coolify",
    reason: "disabled",
    configured: true,
    lastHealthStatus: "needs_reauth",
    lastHealthAt: new Date(Date.now() - 120_000).toISOString(),
  }),
  entry({ provider: "epodsystem", serverName: "epodsystem" }),
  entry({ provider: "sentry", serverName: "sentry" }),
  entry({ source: "project", provider: null, serverName: "docs-search", reason: "ok" }),
];

vi.mock("../hooks", () => ({
  useMcpPreview: () => ({
    isLoading: false,
    isError: false,
    data: { servers, droppedNames: [], stateOnlyNames: [] },
  }),
  useIntegrationsList: () => ({ data: { bindings: [] } }),
  useTestIntegration: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

const sentences = (text: string) => text.trim().split(/(?<=[.!?])\s+/);

describe("McpServersPanel", () => {
  it("titles each row by its provider's name, never a lower-case server id", () => {
    render(<McpServersPanel projectId="p1" />);
    for (const name of ["Postman", "Epodsystem", "Sentry"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.queryByText("postman")).toBeNull();
    expect(screen.queryByText("epodsystem")).toBeNull();
  });

  it("keeps the server's own name where no provider supplies it", () => {
    expect(rowTitle({ provider: null, serverName: "docs-search" })).toBe("docs-search");
  });

  it.each([["the introduction", MCP_PANEL_INTRO], ...REASON_HINTS.map((h) => ["a hint", h])])(
    "words %s in short sentences that name no resolver, override or injection",
    (_what, text) => {
      expect(text).not.toMatch(/resolver|override|inject/i);
      for (const s of sentences(text as string)) {
        expect(s).toMatch(/^[A-Z]/);
        expect(s.split(/\s+/).length).toBeLessThanOrEqual(25);
      }
    },
  );

  // ISS-1421 r8, criterion 130: judge-40 read "It is connected" beside a row whose integration
  // needed sign-in, and "Disabled" where every other surface says Turned off.
  it("never says a row's integration is connected, and names a turned-off row Turned off", () => {
    for (const hint of REASON_HINTS) expect(hint).not.toMatch(/\bconnected\b/i);
    render(<McpServersPanel projectId="p1" />);
    expect(screen.getByText("Turned off")).toBeInTheDocument();
    expect(screen.queryByText("Disabled")).toBeNull();
    // One reading per row: a turned-off row says when it was checked, never what that check found.
    expect(screen.queryByText(/signing in/i)).toBeNull();
    expect(screen.getByText(/^Checked .+\.$/)).toBeInTheDocument();
  });

  // ISS-1421 r9, criterion 130: judge-43 read "Set up Sentry in the list above" beside a Sentry
  // row reading Turned off, whose integration was set up and only turned off.
  it("tells only a row with nothing set up to set it up, never a turned-off one", () => {
    render(<McpServersPanel projectId="p1" />);
    expect(screen.queryByText(/Set up Coolify/)).toBeNull();
    expect(screen.getByText(/^It is set up and turned off/)).toBeInTheDocument();
    expect(screen.getByText(/Set up Sentry in the list above/)).toBeInTheDocument();
  });
});

// ISS-1421 r28 (314): judge-114's plain member read "Switch on … below to allow it." above a switch
// they may not press, on a grant only an owner or admin of the organization may give.
describe("the not-granted hint", () => {
  it("tells a reader who may grant it to switch it on", () => {
    expect(reasonHint("not_granted", { acts: ALL_ACTS })).toMatch(/^No agent on this project may use it yet\. Switch on /);
  });

  it("tells a reader who may not grant it nothing to press", () => {
    const said = reasonHint("not_granted", { acts: { ...ALL_ACTS, grantAgents: false } });
    expect(said).toBe(NOT_GRANTED_YET);
    expect(said).not.toMatch(/Switch on/);
  });
});

// ISS-1421 r36, judge-145: two Coolify deploy targets on one project read "Coolify" twice in the
// Agent MCP servers list, where the Integrations tab tells them apart.
describe("the titles of a provider's several rows", () => {
  const entry = (bindingId: string | null, provider: "coolify" | "postman" | null, stages: ("preview" | "live")[] = ["preview"]) => ({
    provider,
    serverName: provider ?? "docs-search",
    bindingId,
    role: provider === "coolify" ? ("deploy" as const) : null,
    stages: provider === "coolify" ? stages : [],
  });
  const binding = (label: string, config: Record<string, unknown>, createdAt: string) => ({ label, config, createdAt });

  it("names each row by what it points at, as the tab's rows read", () => {
    const rows = [entry("b1", "coolify"), entry("b2", "coolify"), entry(null, null)];
    const titles = rowTitles(
      rows,
      new Map([
        ["b1", binding("", { baseUrl: "https://one.example" }, "2026-10-27T03:34:10.000Z")],
        ["b2", binding("", { baseUrl: "https://two.example" }, "2026-10-27T03:34:12.000Z")],
      ]),
    );
    expect(rows.map((r) => titles.get(r))).toEqual(["Coolify · one.example", "Coolify · two.example", "docs-search"]);
  });

  it("tells two that point at one place apart by when each was connected, under one scope only", () => {
    const rows = [entry("b1", "coolify"), entry("b2", "coolify"), entry("b3", "coolify", ["live"])];
    const at = (createdAt: string) => binding("", { baseUrl: "https://same.example" }, createdAt);
    const titles = rowTitles(
      rows,
      new Map([
        ["b1", at("2026-10-26T03:34:10.000Z")],
        ["b2", at("2026-10-27T03:34:12.000Z")],
        ["b3", at("2026-10-27T03:40:00.000Z")],
      ]),
    );
    const said = rows.map((r) => titles.get(r) as string);
    expect(new Set(said.slice(0, 2)).size).toBe(2);
    expect(said[0]).toMatch(/^Coolify · same\.example · connected /);
    expect(said[2]).toBe("Coolify · same.example");
  });

  it("keeps a provider shared once titled by its name alone", () => {
    const rows = [entry("b1", "postman")];
    expect(rowTitles(rows, new Map([["b1", binding("", {}, "2026-10-27T03:34:10.000Z")]])).get(rows[0])).toBe("Postman");
  });
});

