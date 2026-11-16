// Agents / Capabilities (ISS-1251 §7): the tab opens on its overview, then the project's piles and
// reading, then the doors by where they stand. A door no agent called reads "Teach better / redesign /
// delete", never as a neutral row; a pile over its cap reads "Over"; a door opens in a drawer on its
// teaching, use and reports, and a signal Forge does not record yet reads "Not yet", never 0.
//
// @direct-test-of packages/web-v2/src/features/agents/components/capabilities-band.tsx
// @direct-test-of packages/web-v2/src/features/agents/components/capabilities-budgets.tsx
// @direct-test-of packages/web-v2/src/features/agents/components/capability-detail.tsx
// @direct-test-of packages/web-v2/src/features/agents/components/agents-screen.tsx
// @direct-test-of packages/web-v2/src/features/agents/queries.ts
// @direct-test-of packages/web-v2/src/features/agents/api.ts

import type { CapabilitiesView } from "@forge/contracts/capabilities";
import type { CapabilityCard } from "@forge/contracts/capability-cards";
import type { DoorUseRow, DoorUseView, PilesView } from "@forge/contracts/door-use";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawKeysOnFace } from "@/test/screen-face";
import { Seeded } from "@/test/vi-chrome-requirements";
import { capabilityKeys } from "../queries";
import { CapabilitiesTab } from "./capabilities-tab";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "p-cap";
const card = {
  id: "support.member",
  owner: "support",
  purpose: "Records who a member is",
  situations: [{ when: "Someone writes you have no record of", do: "read who they are first" }],
  practice: ["Read before you reply"],
  audience: ["bot"],
  scenarios: [],
  changed: { on: "2026-11-16", by: "ISS-1251" },
} as CapabilityCard;

const door = (over: Partial<DoorUseRow>): DoorUseRow => ({
  door: "support.member",
  surface: "mcp",
  summary: "records who a member is",
  feature: "forge_support",
  card,
  tiers: { bot: 0 },
  calls: 6,
  refused: 0,
  refusedBy: {},
  byAgent: { "room:support": 5, "session:master": 1 },
  lastAt: "2026-11-15T00:00:00.000Z",
  ...over,
});

const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, calls: i % 3, refused: i % 5 === 0 ? 1 : 0 }));

const use: DoorUseView = {
  projectId: P,
  window: { days: 30, since: "2026-10-17T00:00:00.000Z", until: "2026-11-16T00:00:00.000Z" },
  doors: [
    door({}),
    door({ door: "support.rule", summary: "keeps a rule for the room", card: null, calls: 0, refused: 0, byAgent: {}, lastAt: null }),
    door({ door: "issues.create", summary: "files an issue", calls: 4, refused: 2, refusedBy: { SUPPORT_ACT_DENIED: 2 }, byAgent: { box: 4 } }),
  ],
  totals: { doors: 3, neverUsed: 1, calls: 10, taught: 2 },
  days,
  unmatched: [],
  reads: [{ agent: "session:master", kind: "knowledge", how: "get", reaches: 3, entries: 2, top: [] }],
  lessonsApplied: [{ lesson: "L-7", agent: "agent-account", applications: 2 }],
  limits: [],
};

const piles: PilesView = {
  projectId: P,
  piles: [
    { pile: "always_knowledge", name: "always-on knowledge", size: 7200, cap: 6000, items: 12, carried: 12, over: true },
    { pile: "tier0_map", name: "map (bot)", size: 900, cap: 2500, items: 9, carried: 9, over: false },
    { pile: "skill_always_on", name: "forge-master", size: 400, cap: 1024, items: 1, carried: 1, over: false },
  ],
};

const extra: CapabilitiesView = {
  projectId: P,
  window: use.window,
  feedback: [{ door: "issues.create", reports: 1, byVerdict: { unclear: 1 }, lastAt: "2026-11-15T00:00:00.000Z" }],
  lessons: [],
  freshness: [{ card: "support.member", recheckOwed: null, scenarios: [{ name: "a stranger writes", passed: true, at: "2026-11-16T00:00:00.000Z" }, { name: "a member returns", passed: false, at: "2026-11-16T00:00:00.000Z" }], proposed: [{ field: "redFlag", text: "Replying before reading the member" }] }],
  limits: [],
};

const tab = () =>
  render(
    <Seeded
      data={[
        [capabilityKeys.doors(P), use],
        [capabilityKeys.piles(P), piles],
        [capabilityKeys.extra(P), extra],
      ]}
    >
      <CapabilitiesTab projectId={P} />
    </Seeded>,
  );

const rowOf = (standing: string) => {
  const row = screen.getAllByTestId("cap-door").find((r) => r.getAttribute("data-standing") === standing);
  if (!row) throw new Error(`no ${standing} door`);
  return row;
};

const open = (row: HTMLElement) => {
  const head = row.querySelector<HTMLElement>("[data-expand-head]");
  if (!head) throw new Error("row has no head");
  fireEvent.click(head);
  const detail = document.getElementById(head.getAttribute("aria-controls") ?? "");
  if (!detail) throw new Error("row opened no drawer");
  return detail;
};

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("Agents / Capabilities", () => {
  it("opens on its figures, the doors by standing and calls against refusals per day", () => {
    tab();
    const band = screen.getByTestId("capabilities-band");
    const figures = within(band).getAllByTestId("band-figure").map((f) => [f.getAttribute("data-key"), within(f).getByTestId("band-figure-value").textContent]);
    expect(figures).toEqual([
      ["calls", "10"],
      ["taught", "2/3"],
      ["unused", "1"],
      ["over", "1"],
    ]);
    expect(within(band).getByTestId("capabilities-band-chart")).toBeTruthy();
    expect(screen.getByTestId("band-flow").textContent).toContain("Unused");
  });

  it("reads a door no agent called as teach better, redesign or delete, never neutral", () => {
    tab();
    const unused = rowOf("unused");
    const chip = within(unused).getByTestId("cap-standing");
    expect(chip.textContent).toMatch(/^Teach better \/ redesign \/ delete/);
    expect(chip.getAttribute("data-reason")).toBe("Uncalled for 30 days");
    expect(screen.getByTestId("cap-group-unused").textContent).toMatch(/^Unused1/);
    expect(within(rowOf("inUse")).getByTestId("cap-standing").textContent).toMatch(/^In use/);
  });

  it("reads a door refused on half its calls and reported as used badly, its refusals by code in words", () => {
    tab();
    const detail = open(rowOf("misused"));
    expect(within(detail).getByTestId("cap-refusal-codes").textContent).toContain("Support act denied");
    expect(within(detail).getByTestId("cap-reports").textContent).toContain("Unclear1");
    expect(within(detail).getAllByTestId("cap-not-yet").length).toBeGreaterThan(0);
  });

  it("opens a taught door on its situations, its callers by audience, and misses not yet recorded", () => {
    tab();
    const detail = open(rowOf("inUse"));
    expect(within(detail).getByTestId("cap-teaching").textContent).toContain("Someone writes you have no record of");
    expect(within(detail).getByTestId("cap-in-map").textContent).toContain("Bot");
    const calls = within(detail).getByTestId("cap-calls").textContent ?? "";
    expect(calls).toContain("Bot5");
    expect(calls).toContain("Master1");
    expect(within(detail).getByText("Misses").parentElement?.textContent).toContain("Not yet");
    expect(within(detail).getByTestId("cap-scenarios").textContent).toContain("1 of 2 pass");
    expect(within(detail).getByTestId("cap-recheck").textContent).toContain("Not owed");
    expect(within(detail).getByTestId("cap-lessons").textContent).toContain("Replying before reading the member");
  });

  it("marks a pile over its cap Over, and one within it not", () => {
    tab();
    expect(screen.getByTestId("cap-budgets").textContent).toContain("1 over");
    fireEvent.click(within(screen.getByTestId("cap-budgets")).getByRole("button"));
    const rows = screen.getAllByTestId("cap-pile");
    const over = rows.find((r) => r.textContent?.includes("Always-on knowledge"));
    const within_ = rows.find((r) => r.textContent?.includes("Map · Bot"));
    expect(over && within(over).getByTestId("cap-pile-over").textContent).toBe("Over");
    expect(within_ && within(within_).queryByTestId("cap-pile-over")).toBeNull();
  });

  it("names no issue key or sha on its face", () => {
    const { container } = tab();
    expect(rawKeysOnFace(container)).toEqual([]);
  });
});
