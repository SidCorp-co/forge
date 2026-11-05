// ISS-979 (the owner's mockup v3): each lane of the workspace's Activity tab, as core read it. Under the
// name, the state and what it has queued, why it stands so only a tooltip; on the track, runs as light
// bars (a live one solid), batches of status moves as numbered circles (summary on hover, each issue
// from → to on click), releases as diamonds in their state's colour (version, time and count; its
// issues and Open release) and what waits on the reader as amber pins (each item, Answer first and
// Open all); on the right, the reader's amber count and when the project last moved. "Releases only"
// hides the batches.
//
// @direct-test-of packages/web-v2/src/features/activity/components/lanes.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/marks.tsx
// @direct-test-of packages/web-v2/src/design/patterns/timeline.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/pane.tsx

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMINHUB, AHAPI, ago, CATALOG, FORGE, ORG, project, QUESTION_ID, read, SILENT, serve } from "@/test/activity.fixture";
import { MARK_STEP, spreadMarks } from "@/design";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: ORG }) }));

import { ActivityScreen } from "./activity-screen";

/** Where core placed a mark along the track, in percent: its `left` is `calc(<at>% + <shift>px)`. */
function leftPct(el: HTMLElement | null | undefined): number {
  const m = /(-?[\d.]+)%/.exec(el?.style.left ?? "");
  return m ? Number(m[1]) : Number.NaN;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/activity");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const rowOf = (name: string) => {
  const row = screen.getAllByTestId("list-row").find((r) => within(r).queryByTestId("activity-name")?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};
/** Opens a project's peek: its name is the link a plain click opens it from. */
const peekOf = (name: string) => fireEvent.click(within(rowOf(name)).getByTestId("activity-name"));
const pop = () => screen.findByTestId("mark-pop");

describe("the Activity tab's lanes", () => {
  it("under the name: the state and what it has queued; why it stands so is the state's tooltip, never text", async () => {
    serve(read([FORGE, ADMINHUB, AHAPI, SILENT, CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const state = (name: string) => within(rowOf(name)).getByTestId("activity-state");
    expect([state("Forge").getAttribute("data-standing"), state("Forge").textContent]).toEqual(["working", "Working· 43 queued"]);
    expect(state("AdminHub FE").textContent).toBe("Idle· 2 queued");
    expect(state("AdminHub API").textContent).toBe("Paused· 0 queued");
    expect(state("Catalog API").textContent).toBe("No master· 0 queued");
    expect(rowOf("AdminHub FE").textContent).not.toContain("one at a time");
    const trigger = state("AdminHub API").parentElement;
    if (!trigger) throw new Error("no tooltip trigger");
    fireEvent.focus(trigger);
    expect(await screen.findByText("Stopped on a question at its box")).toBeTruthy();
  });

  it("a lane draws its runs, light and a live one solid, each mark where core placed it, and no pass", async () => {
    serve(read([FORGE, CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const lane = within(within(rowOf("Forge")).getByTestId("timeline-track"));
    const runs = lane.getAllByTestId("timeline-run");
    expect(runs.map((r) => r.getAttribute("data-live"))).toEqual([null, "true"]);
    // a run still running reaches the now edge; one that ended stops where it ended
    expect(Number.parseFloat(runs[1]?.style.right ?? "")).toBeCloseTo(0, 0);
    expect(Number.parseFloat(runs[0]?.style.right ?? "")).toBeCloseTo(58.3, 0);
    // a batch 75 minutes before now sits 37.5% of the way along two hours, its count its issues
    const batch = lane.getByTestId("mark-batch");
    expect(leftPct(batch)).toBeCloseTo(37.5, 0);
    expect(batch.textContent).toContain("3");
    expect(lane.getAllByTestId("mark-release")).toHaveLength(2);
    expect(lane.getAllByTestId("mark-wait").map((w) => w.firstElementChild?.textContent)).toEqual(["2", "1"]);
    expect(screen.queryByTestId("timeline-tick")).toBeNull();
    // a project with no master still draws what core read on its lane: its failed release
    expect(within(rowOf("Catalog API")).getAllByTestId("mark-release")).toHaveLength(1);
  });

});

describe("the Activity tab's marks", () => {
  it("a batch summarises on hover, and on click lists each issue from → to, each a link by its title", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const batch = within(rowOf("Forge")).getByTestId("mark-batch");
    expect(batch.getAttribute("aria-label")).toBe("3 issues · 2 → In progress, 1 → Awaiting release");
    expect(within(batch).getByTestId("timeline-tip").textContent).toBe("3 issues · 2 → In progress, 1 → Awaiting release");
    fireEvent.click(batch);
    const p = within(await pop());
    expect(p.getByTestId("mark-pop-title").textContent).toBe("Forge · 3 issues moved");
    const items = p.getAllByTestId("mark-pop-item");
    expect(items.map((i) => i.textContent)).toEqual([
      "Reopened issue held by its old releaseIn progress → Awaiting release",
      "Sweep loops on a held headOpen → In progress",
      "Rooms read lists its threadsOpen → In progress",
    ]);
    expect([items[0]?.getAttribute("href"), items[0]?.getAttribute("title")]).toEqual(["/projects/forge-slug/issues/ISS-967", "ISS-967"]);
  });

  it("a release diamond wears its state; on click it lists its issues, how many more, and Open release", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const [released, releasing] = within(rowOf("Forge")).getAllByTestId("mark-release");
    expect(released?.querySelector(".bg-ok-9")).not.toBeNull();
    expect(releasing?.querySelector(".bg-info-9")).not.toBeNull();
    expect(released?.getAttribute("aria-label")).toMatch(/^0\.4\.0-dev\.499 · released \d{2}:\d{2} · 11 issues$/);
    if (!released) throw new Error("no released diamond");
    fireEvent.click(released);
    const p = within(await pop());
    expect(p.getByTestId("mark-pop-title").textContent).toBe("Forge 0.4.0-dev.499");
    expect(p.getAllByTestId("mark-pop-item").map((i) => i.textContent)).toEqual(["Reopened issue held by its old release"]);
    expect(p.getByText("+10 more")).toBeTruthy();
    expect(p.getByTestId("mark-pop-act").getAttribute("href")).toBe("/projects/forge-slug/releases/0.4.0-dev.499");
  });

  it("a pin waits where the wait began; on click it lists each item, Answer first and Open all", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const [first] = within(rowOf("Forge")).getAllByTestId("mark-wait");
    expect(leftPct(first)).toBeCloseTo(75, 0);
    expect(first?.getAttribute("aria-label")).toBe("2 waiting on you · 1 question, 1 approval");
    if (!first) throw new Error("no pin");
    fireEvent.click(first);
    const p = within(await pop());
    expect(p.getAllByTestId("mark-pop-item").map((i) => i.textContent)).toEqual([
      "Can the stg vhost be changed today, or only in the Friday window?Question",
      "Accept revision r4Approval",
    ]);
    const acts = p.getAllByTestId("mark-pop-act");
    expect(acts.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Open all", "/projects/forge-slug/approvals"],
      ["Answer first", `/projects/forge-slug/approvals?peek=${encodeURIComponent(`question:${QUESTION_ID}`)}`],
    ]);
  });

  it("the You count is the reader's, amber, and opens every item it holds and how many more", async () => {
    serve(read([FORGE, ADMINHUB]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(within(rowOf("AdminHub FE")).queryByTestId("activity-you")).toBeNull();
    fireEvent.click(within(rowOf("Forge")).getByTestId("activity-you"));
    const p = within(await pop());
    expect(p.getByTestId("mark-pop-title").textContent).toBe("Forge · 43 waiting on you");
    expect(p.getAllByTestId("mark-pop-item")).toHaveLength(3);
    expect(p.getByText("+40 more")).toBeTruthy();
  });

  it("Releases only hides the batches and the batch's legend; the diamonds and pins stay", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(screen.getByTestId("legend-batch")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("activity-view")).getByText("Releases only"));
    await waitFor(() => expect(within(rowOf("Forge")).queryByTestId("mark-batch")).toBeNull());
    expect(screen.queryByTestId("legend-batch")).toBeNull();
    expect(within(rowOf("Forge")).getAllByTestId("mark-release")).toHaveLength(2);
    expect(within(rowOf("Forge")).getAllByTestId("mark-wait")).toHaveLength(2);
    expect(window.location.search).toContain("view=releases");
  });

  it("the right column says when the project last moved, a dash where nothing is recorded", async () => {
    serve(read([FORGE, CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(within(rowOf("Forge")).getByTestId("activity-last").textContent).toBe("3 min ago");
    expect(within(rowOf("Catalog API")).getByTestId("activity-last").textContent).toBe("—");
  });

  it("the peek labels both release counts", async () => {
    serve(read([CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Catalog API");
    peekOf("Catalog API");
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByRole("region", { name: "To release" }).textContent).toBe("To release44");
    expect(within(peek).getByTestId("activity-release").textContent).toContain("7/15");
  });
});

describe("the Activity tab's marks never cover each other (ISS-979 fix round)", () => {
  // the live page drew a release diamond on a batch circle (Agenfold about 12:44, Forge at now), so
  // the one beneath could be neither hovered nor clicked; and Forge's pin read 3 while 6 waited
  const CROWDED = project({
    projectId: "p-crowd",
    slug: "crowd-slug",
    name: "Crowded",
    standing: "idle",
    people: { total: 7, items: [] },
    lane: {
      from: ago(7200),
      runs: [],
      batches: [{ at: ago(1200), moves: [{ issueKey: "ISS-1", title: "One", from: "open", to: "in_progress" }] }],
      releases: [
        { at: ago(1190), version: "1.0.1", state: "released", total: 1, issues: [{ key: "ISS-1", title: "One" }] },
        { at: ago(4000), version: "1.0.0", state: "released", total: 1, issues: [{ key: "ISS-0", title: "Zero" }] },
      ],
      waits: [{ at: ago(7200), items: [], more: 7 }],
    },
  });

  it("a release on a batch steps aside, the earlier keeps its spot, and one standing alone stays put", async () => {
    serve(read([CROWDED]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Crowded");
    const lane = within(within(rowOf("Crowded")).getByTestId("timeline-track"));
    expect(lane.getByTestId("mark-batch").hasAttribute("data-shift")).toBe(false);
    const [late, alone] = lane.getAllByTestId("mark-release");
    expect(late?.getAttribute("aria-label")).toContain("1.0.1");
    expect(late?.getAttribute("data-shift")).toBe(String(MARK_STEP));
    expect(late?.style.left).toContain(`+ ${MARK_STEP}px`);
    expect(alone?.hasAttribute("data-shift")).toBe(false);
  });

  it("a pin counts every decision waiting, those core carries no item for included, as the You count does", async () => {
    serve(read([CROWDED]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Crowded");
    const [pin] = within(rowOf("Crowded")).getAllByTestId("mark-wait");
    expect(pin?.firstElementChild?.textContent).toBe("7");
    expect(within(rowOf("Crowded")).getByTestId("activity-you").textContent).toBe("7");
    if (!pin) throw new Error("no pin");
    fireEvent.click(pin);
    expect(within(await pop()).getByText("+7 more")).toBeTruthy();
  });

  it("spreads marks: under a pin a mark hangs below, a crowded run steps aside, leftwards near now, and a pin never moves", () => {
    const spots = spreadMarks([
      { key: "pin", at: 10, pin: true },
      { key: "near-pin", at: 11, pin: false },
      { key: "first", at: 50, pin: false },
      { key: "second", at: 51.5, pin: false },
      { key: "third", at: 53, pin: false },
      { key: "late", at: 97, pin: false },
      { key: "later", at: 98, pin: false },
    ]);
    expect(Object.fromEntries([...spots].map(([k, v]) => [k, [v.lowered, v.shift]]))).toEqual({
      pin: [false, 0],
      "near-pin": [true, 0],
      first: [false, 0],
      second: [false, MARK_STEP],
      third: [false, 2 * MARK_STEP],
      late: [false, 0],
      later: [false, -MARK_STEP],
    });
  });

});
