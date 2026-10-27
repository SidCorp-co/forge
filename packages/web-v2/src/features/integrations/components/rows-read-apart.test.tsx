// @vitest-environment jsdom
//
// ISS-1421 r35, judge-141: two unlabelled Coolify rows on a project's Integrations tab read
// "Preview / Turned off" twice once both were switched off, so a person could not tell which was
// which before opening one. Each row names what tells it apart: its label, else its store or host,
// else the day and time it was connected, else a number.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCard } from "../types";
import { ALL_MAY } from "../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";

const state = {
  cards: [] as StatusCard[],
  items: [] as Array<{ id: string; createdAt: string }>,
};

vi.mock("../hooks", () => ({
  useIntegrationsStatus: () => ({
    data: { cards: state.cards },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useIntegrationsList: () => ({ data: { items: state.items, bindings: state.items, may: ALL_MAY } }),
}));
vi.mock("./connection-detail-drawer", () => ({ ConnectionDetailDrawer: () => null }));
vi.mock("./mcp-servers-panel", () => ({ McpServersPanel: () => null }));

const { ProjectIntegrationsPanel, rowHeadings } = await import("./project-integrations-panel");

/** A Coolify preview row turned off, as core's status read gives it, keyed apart by its binding. */
function coolify(id: string, meta: Record<string, unknown> = {}): StatusCard {
  return {
    key: `coolify:preview:${id}`,
    label: "Coolify (Preview)",
    status: "disabled",
    detail: "Turned off.",
    lastSyncAt: null,
    configured: true,
    meta: { bindingId: id, role: "deploy", stages: ["preview"], ...meta },
  };
}

beforeEach(() => {
  state.cards = [];
  state.items = [];
});
afterEach(cleanup);

describe("a provider's rows on the Integrations tab", () => {
  it("two unlabelled rows switched off read apart, and so do their Manage buttons", () => {
    state.cards = [coolify("b-1"), coolify("b-2")];
    state.items = [
      { id: "b-1", createdAt: "2026-10-01T09:00:00.000Z" },
      { id: "b-2", createdAt: "2026-10-20T09:00:00.000Z" },
    ];
    render(<ProjectIntegrationsPanel projectId={PROJECT} />);
    const rows = within(screen.getByTestId("integration-rows")).getAllByRole("button", { name: /^Manage Coolify/ });
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    const headings = rows.map((r) => r.querySelector("p")?.textContent);
    expect(new Set(headings).size).toBe(2);
    expect(headings[0]).toMatch(/^Preview · connected 1 Oct 2026$/);
  });

  it("names a row by its label, else its store, else the host it points at", () => {
    const cards = [
      coolify("b-1", { label: "partner-a", baseUrl: "https://coolify.one.test" }),
      coolify("b-2", { storeName: "Store B" }),
      coolify("b-3", { baseUrl: "https://coolify.two.test" }),
    ];
    const headings = rowHeadings("coolify", cards, new Map());
    expect(cards.map((c) => headings.get(c.key))).toEqual([
      "Preview · partner-a",
      "Preview · Store B",
      "Preview · coolify.two.test",
    ]);
  });

  it("tells two on one host apart by the day, then the time, then a number", () => {
    const host = { baseUrl: "https://coolify.one.test" };
    const cards = [coolify("b-1", host), coolify("b-2", host), coolify("b-3", host), coolify("b-4", host)];
    const at = new Map([
      ["b-1", "2026-10-01T09:00:00.000Z"],
      ["b-2", "2026-10-20T09:00:00.000Z"],
      ["b-3", "2026-10-20T09:00:00.000Z"],
    ]);
    const headings = [...rowHeadings("coolify", cards, at).values()];
    expect(new Set(headings).size).toBe(4);
    expect(headings.every((h) => h.startsWith("Preview · coolify.one.test"))).toBe(true);
    expect(headings.filter((h) => h.includes("connected 20 Oct 2026,"))).toHaveLength(2);
  });

  it("leaves a row that reads like no other as it is", () => {
    const cards = [coolify("b-1"), { ...coolify("b-2"), key: "coolify:live:b-2", meta: { bindingId: "b-2", role: "deploy", stages: ["live"] } }];
    const headings = rowHeadings("coolify", cards, new Map([["b-1", "2026-10-01T09:00:00.000Z"]]));
    expect(cards.map((c) => headings.get(c.key))).toEqual(["Preview", "Live"]);
  });
});
