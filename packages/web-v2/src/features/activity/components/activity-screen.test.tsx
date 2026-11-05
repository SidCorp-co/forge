// ISS-951 (MK-8, MK-9, then MK-10 C) and ISS-979 (the owner's mockup v3): the workspace's Activity tab
// draws one lane per project in core's groups, Waiting on you first, then Working, Idle, Paused and No
// master, each the shared group hierarchy with its lanes indented under it. Chips count projects in
// those groups. A lane draws its runs as bars (a live one solid), its status moves in batches (a
// numbered circle: its summary on hover, each issue from → to on click), its releases as diamonds in
// their state's colour (version, time and count; its issues and Open release) and what waits on the
// reader as amber pins (each item, Answer first and Open all), all as core read them. "Releases only"
// hides the batches. Under the name: the state and what it has queued, why it stands so a tooltip; on
// the right, the reader's amber count and when the project last moved. It opens one project's peek
// (Now, Backlog, People, a dialog's text, both release counts, a Recent list read only when opened)
// that the arrow keys switch and Esc closes, listens on the org's room, keeps its last answer on screen
// while it reads again, and never shows a slug, an id, a record key or internal jargon as text.
//
// @direct-test-of packages/web-v2/src/design/patterns/peek-panel.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/activity-peek.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/pane.tsx
// @direct-test-of packages/web-v2/src/features/activity/hooks.ts
// @direct-test-of packages/web-v2/src/features/activity/api.ts
// @direct-test-of packages/web-v2/src/features/activity/index.ts
// @direct-test-of packages/web-v2/src/lib/ws/rooms.ts
// @direct-test-of packages/web-v2/src/lib/ws/event-router.ts
// @direct-test-of packages/web-v2/src/routes/_workspace/activity/index.tsx
// @direct-test-of packages/web-v2/src/design/patterns/filter-chip.tsx

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMINHUB, AHAPI, CATALOG, FORGE, master, ORG, QUESTION_ID, QUIET, RECENT, read, SILENT, serve } from "@/test/activity.fixture";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";

const rooms: string[] = [];
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: (room: string | null) => void (room && rooms.push(room)) }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: ORG }) }));

import { routeEvent } from "@/lib/ws/event-router";
import { ActivityScreen } from "./activity-screen";

beforeEach(() => {
  rooms.length = 0;
  window.history.replaceState(null, "", "/activity");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // a fold one test makes is session state the next would read
  sessionStorage.clear();
});

const rowOf = (name: string) => {
  const row = screen.getAllByTestId("list-row").find((r) => within(r).queryByTestId("activity-name")?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};
/** Opens a project's peek: its name is the link a plain click opens it from. */
const peekOf = (name: string) => fireEvent.click(within(rowOf(name)).getByTestId("activity-name"));
const groupsShown = () => screen.getAllByTestId("list-group").map((g) => g.getAttribute("data-group"));
const pop = () => screen.findByTestId("mark-pop");
const KEY = /\b(ISS|FB|REQ)-\d+/;

describe("the Activity tab", () => {
  it("draws core's rows in core's groups, Waiting on you first, and listens on the org's room", async () => {
    serve(read([FORGE, ADMINHUB, AHAPI, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(groupsShown()).toEqual(["you", "idle", "paused", "none"]);
    expect(screen.getAllByTestId("list-group").map((g) => within(g).getByTestId("group-label").textContent)).toEqual(["Waiting on you", "Idle", "Paused", "No master"]);
    expect(rooms).toContain(`org:${ORG}`);
  });

  it("each group is the shared hierarchy: its lanes indented under its label", async () => {
    serve(read([FORGE, ADMINHUB, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    for (const row of screen.getAllByTestId("list-row")) {
      const lead = row.firstElementChild;
      expect(lead?.className.split(/\s+/), "a lane is not indented under its group").toContain("pl-8");
    }
    // folding a group hides its lanes; its chevron stays shown while folded
    const idle = screen.getAllByTestId("list-group").find((g) => g.getAttribute("data-group") === "idle") as HTMLElement;
    fireEvent.click(idle);
    await waitFor(() => expect(screen.queryByText("AdminHub FE")).toBeNull());
    expect(within(idle).getByTestId("group-chevron").getAttribute("class")).toContain("-rotate-90");
  });

  it("shows no slug, id, record key or jargon as text, in the lanes, every popover, the peek or its Recent list", async () => {
    serve(read([FORGE, ADMINHUB, AHAPI, CATALOG, SILENT, QUIET]));
    const { container } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const body = () => container.ownerDocument.body.textContent ?? "";
    const forge = within(rowOf("Forge"));
    for (const mark of [forge.getByTestId("mark-batch"), ...forge.getAllByTestId("mark-release"), ...forge.getAllByTestId("mark-wait"), forge.getByTestId("activity-you")]) {
      fireEvent.click(mark);
      await pop();
      expect(body().match(KEY) ?? [], "a record key is drawn as text in a popover").toEqual([]);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("mark-pop")).toBeNull());
    }
    peekOf("Forge");
    const recent = within(await screen.findByTestId("activity-peek")).getByTestId("activity-recent");
    fireEvent.click(within(recent).getByText("Recent"));
    await waitFor(() => expect(within(recent).getAllByTestId("row-item")).toHaveLength(4));
    const text = body();
    for (const raw of ["forge-slug", "p-forge", "i-948", ORG, QUESTION_ID]) {
      expect(text, `${raw} is drawn as text`).not.toContain(raw);
    }
    expect(text.match(new RegExp(KEY, "g")) ?? [], "a record key is drawn as text").toEqual([]);
    for (const jargon of ["Dispatch", "pool closed", "Master pass", "Dialog wait"]) expect(text, `"${jargon}" is drawn`).not.toContain(jargon);
  });

  it("a question waiting on the reader reads as its own words in the peek, its key only on hover", async () => {
    serve(read([FORGE, ADMINHUB]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    peekOf("Forge");
    const people = within(await screen.findByTestId("activity-peek")).getByRole("region", { name: "People" });
    const [item] = within(people).getAllByTestId("row-item");
    expect(item?.textContent).toContain("Can the stg vhost be changed today, or only in the Friday window?");
    expect(people.textContent).not.toMatch(KEY);
    // each answers where it is decided: the project's Approvals with that decision open
    expect(item?.querySelector("a")?.getAttribute("href")).toBe(`/projects/forge-slug/approvals?peek=${encodeURIComponent(`question:${QUESTION_ID}`)}`);
  });

  it("the peek's key hint names the arrows it draws", async () => {
    serve(read([FORGE, ADMINHUB]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    peekOf("Forge");
    const keys = within(await screen.findByTestId("activity-peek")).getByTestId("peek-keys");
    expect([...keys.querySelectorAll("kbd")].map((k) => k.textContent).slice(0, 2)).toEqual(["↑", "↓"]);
  });

  it("the chips count projects in the groups, only groups that hold one, and keep only the rows they name", async () => {
    serve(read([FORGE, ADMINHUB, AHAPI, SILENT, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const chips = screen.getAllByTestId(/^activity-show-/).map((c) => [c.getAttribute("data-testid"), c.textContent]);
    expect(chips).toEqual([
      ["activity-show-all", "All6"],
      ["activity-show-you", "Waiting on you1"],
      ["activity-show-idle", "Idle2"],
      ["activity-show-paused", "Paused2"],
      ["activity-show-none", "No master1"],
    ]);
    // Waiting on you wears amber until it is pressed
    expect(screen.getByTestId("activity-show-you").getAttribute("style")).toContain("--amberw-50");
    fireEvent.click(screen.getByTestId("activity-show-paused"));
    await waitFor(() => expect(screen.getAllByTestId("list-row").map((r) => within(r).getByTestId("activity-name").textContent)).toEqual(["AdminHub API", "Orbit"]));
    fireEvent.click(screen.getByTestId("activity-show-you"));
    await waitFor(() => expect(screen.getAllByTestId("list-row")).toHaveLength(1));
    expect(screen.getByTestId("activity-show-you").getAttribute("style") ?? "").not.toContain("--amberw-50");
  });

});

describe("the Activity tab's peek and reads", () => {
  it("the peek shows Now, Backlog and People; the arrow keys switch project and Esc closes", async () => {
    serve(read([FORGE, ADMINHUB, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    peekOf("Forge");
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByText("The demo seed asks a steward decision")).toBeTruthy();
    expect(within(peek).getByText("The steward names the events door")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(within(screen.getByTestId("activity-peek")).getByTestId("peek-head").textContent).toContain("AdminHub FE"));
    expect(within(screen.getByTestId("activity-peek")).getByTestId("activity-skip-line").textContent).toBe("Took nothing: one at a time");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("activity-peek")).toBeNull());
  });

  it("a waiting dialog's text is in the peek, under its Dialog badge", async () => {
    serve(read([AHAPI]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("AdminHub API");
    peekOf("AdminHub API");
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByTestId("activity-dialog").textContent).toBe("Allow Bash: curl -sS https://staging.example ?");
    expect(within(peek).getByTestId("activity-pane").getAttribute("data-pane")).toBe("dialog");
  });

  it("Recent is closed until clicked, and only then reads the project's events", async () => {
    const calls = serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(calls.some((c) => c.path.endsWith("/recent")), "the list read Recent").toBe(false);
    peekOf("Forge");
    const recent = within(await screen.findByTestId("activity-peek")).getByTestId("activity-recent");
    expect(recent.hasAttribute("open")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/recent")), "a closed Recent was read").toBe(false);
    fireEvent.click(within(recent).getByText("Recent"));
    await waitFor(() => expect(within(recent).getAllByTestId("row-item")).toHaveLength(4));
    expect(recent.textContent).toContain("Run started · The ETA cell reads its paused reason");
    expect(recent.textContent).toContain("Pass settled · dispatched 1");
    expect(recent.textContent).toContain("Change request !135 · A landing moves the step");
    expect(recent.textContent).toContain("Recent names each issue → Open");
  });

  it("an org with no project the reader can read says so", async () => {
    serve(read([]));
    renderWithQuery(<ActivityScreen />);
    expect(await screen.findByText("No projects")).toBeTruthy();
    expect(screen.queryByTestId("timeline-frame")).toBeNull();
  });

  it("reads again when the org's room says a project moved, keeping the last answer on screen meanwhile", async () => {
    let body = read([FORGE, QUIET]);
    let hang = false;
    const calls = fakeCore((call) => (call.path === `/orgs/${ORG}/activity` ? (hang ? HANG : { body }) : undefined));
    const { client } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const reads = () => calls.filter((c) => c.path === `/orgs/${ORG}/activity`).length;
    expect(reads()).toBe(1);
    const moved = (orgId: string) =>
      routeEvent({ event: "org.activity.changed", data: { orgId, projectId: "p-q", source: "master" }, timestamp: new Date().toISOString() }, client);
    moved("another-org");
    await new Promise((r) => setTimeout(r, 400));
    expect(reads(), "another org's frame read this page again").toBe(1);
    body = read([{ ...QUIET, group: "working", standing: "working", master: master({ state: "busy" }) }]);
    moved(ORG);
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(groupsShown()).toEqual(["working"]));
    body = read([FORGE, QUIET]);
    moved(ORG);
    await waitFor(() => expect(reads()).toBe(3));
    await screen.findByText("Forge");
    hang = true;
    moved(ORG);
    await waitFor(() => expect(reads()).toBe(4));
    await waitFor(() => expect(screen.getByTestId("activity-updating").textContent).toBe("updating"));
    expect(screen.getByText("Forge"), "the last answer left the screen while it read again").toBeTruthy();
    expect(screen.queryByText("loading activity…")).toBeNull();
  });

  it("reads once more while core says it is still reading behind its answer, and stops when it is not", async () => {
    let refreshing = true;
    const calls = fakeCore((call) => (call.path === `/orgs/${ORG}/activity` ? { body: read([FORGE], refreshing) } : undefined));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const reads = () => calls.filter((c) => c.path === `/orgs/${ORG}/activity`).length;
    refreshing = false;
    await waitFor(() => expect(reads()).toBe(2), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 3_500));
    expect(reads(), "the page went on reading after core said it was done").toBe(2);
  }, 12_000);
});

describe("the peek's Recent list", () => {
  it("answers while the org's room moves faster than Recent reads: a frame does not cancel its read", async () => {
    const calls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const path = new URL(input, "http://forge.test").pathname.replace(/^\/api/, "");
        calls.push(path);
        if (path === `/orgs/${ORG}/activity`) return json(read([FORGE]));
        // Recent takes longer than the room's frames come
        await new Promise((r) => setTimeout(r, 600));
        return json(RECENT);
      }),
    );
    const { client } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    peekOf("Forge");
    const recent = within(await screen.findByTestId("activity-peek")).getByTestId("activity-recent");
    fireEvent.click(within(recent).getByText("Recent"));
    const frames = setInterval(() => {
      routeEvent({ event: "org.activity.changed", data: { orgId: ORG, projectId: "p-forge", source: "master" }, timestamp: new Date().toISOString() }, client);
    }, 150);
    try {
      await waitFor(() => expect(within(recent).getAllByTestId("row-item")).toHaveLength(4), { timeout: 4_000 });
    } finally {
      clearInterval(frames);
    }
    expect(calls.filter((c) => c.endsWith("/recent")), "each frame cancelled Recent's read and started it again").toHaveLength(1);
  }, 10_000);
});
