// ISS-979 (the owner's mockup v3): each lane of the workspace's Activity tab, as core read it. Under the
// name, the state and what it has queued, why it stands so only a tooltip; on the track, runs as light
// bars (a live one solid), batches of status moves as numbered circles (summary on hover, each issue
// from → to on click), releases as diamonds in their state's colour (version, time and count; its
// issues and Open release) and what waits on the reader as amber pins (each item, Answer first and
// Open all); on the right, the reader's amber count and when the project last moved. "Releases"
// hides the batches.
//
// @direct-test-of packages/web-v2/src/features/activity/components/lanes.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/marks.tsx
// @direct-test-of packages/web-v2/src/design/patterns/timeline.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/pane.tsx

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMINHUB, AHAPI, ago, CATALOG, FORGE, ORG, person, project, QUESTION_ID, read, SILENT, serve } from "@/test/activity.fixture";
import { MARK_STEP, spreadMarks, TRACK_FLOOR_PX } from "@/design";
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
  it("a mark whose popover Escape closed shows no summary until the pointer comes back to it, so a neighbour's is the only one (fix round 3)", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const batch = within(rowOf("Forge")).getByTestId("mark-batch");
    fireEvent.click(batch);
    await pop();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("mark-pop")).toBeNull());
    expect(within(batch).queryByTestId("timeline-tip")).toBeNull();
    // moving off and focus leaving no longer bring it back; only the pointer returning does
    fireEvent.pointerLeave(batch);
    fireEvent.blur(batch);
    expect(within(batch).queryByTestId("timeline-tip")).toBeNull();
    fireEvent.pointerEnter(batch);
    expect(within(batch).getByTestId("timeline-tip")).toBeTruthy();
  });

  it("on a phone each group's header stays put, the frame's own width, while the lanes scroll under it (fix round 3)", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    for (const header of screen.getAllByTestId("list-group")) {
      expect(header.className).toContain("max-md:sticky");
      expect(header.className).toContain("max-md:w-[100cqw]");
    }
  });

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

  it("a pin at the lane's edge for a wait older than the lane says the day the wait began, not the edge (fix round 3)", async () => {
    const old = person({ decisionId: "question:old", key: "ISS-7", title: "An old question", since: "2026-10-08T03:00:00.000Z" });
    serve(read([project({ projectId: "p-old", slug: "old-slug", name: "Old", standing: "idle", people: { total: 1, items: [old] }, lane: { from: ago(7200), runs: [], batches: [], releases: [], waits: [{ at: ago(7200), items: [old], more: 0 }] } })]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Old");
    const [pin] = within(rowOf("Old")).getAllByTestId("mark-wait");
    if (!pin) throw new Error("no pin");
    fireEvent.click(pin);
    const sub = (await pop()).textContent ?? "";
    expect(sub).toMatch(/Since (8 Oct|Oct 8)/);
  });

  it("You reads pending, never a dash, while core still reads what waits and the page holds nothing earlier (fix round 3)", async () => {
    serve(read([project({ projectId: "p-cold", slug: "cold-slug", name: "Cold", standing: "idle", peoplePending: true, people: { total: 0, items: [] } })]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Cold");
    expect(within(rowOf("Cold")).getByTestId("you-pending").textContent).toBe("…");
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

  it("Releases hides the batches and the batch's legend; the diamonds and pins stay", async () => {
    serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(screen.getByTestId("legend-batch")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("activity-view")).getByText("Releases"));
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
    // ten seconds after the batch: it stands a whole mark past it on the narrowest track
    const shift = Number(late?.getAttribute("data-shift"));
    expect(shift).toBeGreaterThanOrEqual(MARK_STEP - 1);
    expect(shift).toBeLessThanOrEqual(MARK_STEP);
    expect(late?.style.left).toContain(`+ ${shift}px`);
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

  /** Where each mark stands in px on a track `width` px wide, once spread. */
  const standing = (marks: { key: string; at: number; pin: boolean }[], width: number) => {
    const spots = spreadMarks(marks);
    return marks.map((m) => ({ ...m, px: (m.at * width) / 100 + (spots.get(m.key)?.shift ?? 0), lowered: spots.get(m.key)?.lowered ?? false }));
  };

  it("spreads marks so no two stand closer than a mark, at the narrowest track and wider, a crowd never stepping onto a neighbour", () => {
    // the live case at 420 (fix round 3): a crowd of four, then batch "4" just past it, where stepping
    // each crowded mark a fixed 24px put the last of the crowd 18px onto batch "4"
    const crowd = [
      { key: "pin", at: 10, pin: true },
      { key: "near-pin", at: 11, pin: false },
      { key: "c1", at: 50, pin: false },
      { key: "c2", at: 50.5, pin: false },
      { key: "c3", at: 51, pin: false },
      { key: "c4", at: 51.5, pin: false },
      { key: "four", at: 60, pin: false },
      { key: "late", at: 97, pin: false },
      { key: "later", at: 98, pin: false },
      { key: "latest", at: 99.5, pin: false },
    ];
    for (const width of [TRACK_FLOOR_PX, 900, 1400]) {
      const line = standing(crowd, width).filter((m) => !m.pin).sort((x, y) => x.px - y.px);
      for (let i = 1; i < line.length; i++) {
        expect(line[i].px - line[i - 1].px, `${line[i - 1].key} → ${line[i].key} at ${width}px`).toBeGreaterThanOrEqual(MARK_STEP - 1);
      }
      for (const m of line) {
        expect(m.px, `${m.key} at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(m.px, `${m.key} at ${width}px`).toBeLessThanOrEqual(width + 0.5);
      }
    }
    const spots = spreadMarks(crowd);
    // a pin never moves; a mark under it hangs below; the first of a crowd keeps its spot; near now the
    // crowd packs leftwards, and a mark standing alone stays put
    expect(spots.get("pin")).toEqual({ lowered: false, shift: 0 });
    expect(spots.get("near-pin")?.lowered).toBe(true);
    expect(spots.get("c1")?.shift).toBe(0);
    expect(spots.get("later")?.shift).toBeLessThan(0);
    expect(spots.get("late")?.shift).toBeLessThan(0);
    expect(spreadMarks([{ key: "alone", at: 40, pin: false }]).get("alone")).toEqual({ lowered: false, shift: 0 });
  });

});
