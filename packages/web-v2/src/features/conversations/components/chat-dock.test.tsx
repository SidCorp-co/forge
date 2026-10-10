// ISS-277 (FB-88): the dock opened with nothing picked (a reload, a new tab, a project switch) lands
// on the project's latest conversation, the one waiting on the person first, and a conversation
// waiting on the person is one click away from any other. A failed read says so; it never quietly
// opens a new chat in the conversation's place.

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIREFRAME_VERSION } from "@forge/contracts/wireframe";
import { boardStore } from "@/features/board";
import type { ChatDockApi, ChatTarget, DockSize } from "@/features/chat-dock";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ChatDock, ChatDockBody } from "./chat-dock";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/epod/requirements" }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("../board/board-panel", () => ({ BOARD_DOCK_WIDTH: 880, DockBoard: () => <div data-testid="board" /> }));
vi.mock("./conversation-chat", () => ({
  ConversationChat: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="chat" data-conversation={conversationId ?? "new"} />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const project = { id: "p1", name: "epod", slug: "epod" };

function row(id: string, title: string, threadStatus: string, minute: number) {
  return {
    id,
    adapter: "web",
    externalId: id,
    shape: "direct",
    mode: "assistant",
    title,
    updatedAt: `2026-10-06T16:${minute}:00Z`,
    archivedAt: null,
    ecosystemId: null,
    kind: null as string | null,
    threadStatus,
    subjectKey: null as string | null,
  };
}

type Room = ReturnType<typeof row>;

const drafted = row("c-req1", "Draft REQ-1", "waiting_on_you", 51);
const later = row("c-other", "Something else", "done", 53);

function core(rooms: Room[] | "refused") {
  return fakeCore(({ path }) => {
    if (path === "/projects") return { body: [project] };
    if (path.startsWith("/conversations?")) {
      return rooms === "refused" ? { status: 500, body: { error: { message: "list read failed" } } } : { body: { items: rooms, total: rooms.length } };
    }
    if (path.startsWith("/conversations/")) {
      const id = path.split("/")[2];
      const listed = rooms === "refused" ? undefined : rooms.find((r) => r.id === id);
      return { body: { id, subjectKey: listed?.subjectKey ?? null, kind: listed?.kind ?? null, ecosystemId: null } };
    }
    return undefined;
  });
}

/** The dock's scope with nothing picked: this project's latest conversation (`targetInScope`, dock-target.test.ts). */
const LATEST: ChatTarget = { kind: "latest", projectId: "p1" };

function dockOn(target: ChatTarget | null): ChatDockApi {
  return {
    projectId: "p1",
    open: true,
    pinned: false,
    setPinned: vi.fn(),
    target,
    generation: 0,
    size: "large",
    setSize: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    select: vi.fn(),
    follow: vi.fn(),
    askAbout: vi.fn(),
    setDoor: vi.fn(),
  };
}

describe("the dock opened with nothing picked", () => {
  it("lands on the conversation waiting on the person, not a new chat", async () => {
    core([later, drafted]);
    const dock = dockOn(LATEST);
    renderWithQuery(<ChatDockBody dock={dock} />);
    await waitFor(() =>
      expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-req1" }),
    );
    expect(screen.queryByTestId("chat")).toBeNull();
  });

  it("opens a new draft only when the project has no conversation", async () => {
    core([]);
    const dock = dockOn(LATEST);
    renderWithQuery(<ChatDockBody dock={dock} />);
    await waitFor(() => expect(dock.select).toHaveBeenCalledWith({ kind: "draft", projectId: "p1" }));
  });

  it("says the list could not be read, with a retry, and opens nothing in its place", async () => {
    core("refused");
    const dock = dockOn(LATEST);
    renderWithQuery(<ChatDockBody dock={dock} />);
    expect(await screen.findByText("Conversations could not be read")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(dock.select).not.toHaveBeenCalled();
  });
});

describe("a conversation waiting on the person", () => {
  it("is offered by name over a new draft, and one click opens it", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "draft", projectId: "p1" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Draft REQ-1, waiting on you" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-req1" });
  });

  it("is offered by name over another open conversation, and one click opens it", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-other" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    expect((await screen.findByTestId("chat")).getAttribute("data-conversation")).toBe("c-other");
    fireEvent.click(await screen.findByRole("button", { name: "Open Draft REQ-1, waiting on you" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-req1" });
  });

  it("is not offered while it is the conversation open", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-req1" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    expect(await screen.findByTestId("chat")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /waiting on you/ })).toBeNull();
  });

  it("still lets New conversation start a fresh draft", () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-other" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "draft", projectId: "p1" });
  });
});

// FB-100: on the Dashboard, Ask Agent reopened the REQ-17 room, which reads only REQ-17; a whole-
// project question asked there was refused after 20 s, and nothing on the panel said why
describe("a room scoped to a record", () => {
  const req17: Room = { ...row("c-req17", "REQ-17 export", "done", 55), kind: "requirement", subjectKey: "REQ-17" };

  it("is not reopened off its record's page when it is not waiting on the person", async () => {
    core([later, req17]);
    const dock = dockOn(LATEST);
    renderWithQuery(<ChatDockBody dock={dock} />);
    await waitFor(() =>
      expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-other" }),
    );
  });

  it("names its scope as a state, and offers the whole project in one click", async () => {
    core([later, req17]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-req17" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    const note = await screen.findByTestId("subject-scope-notice");
    expect(note.textContent).toContain("Reads REQ-17 only, not the whole project.");
    fireEvent.click(screen.getByRole("button", { name: "New conversation about the whole project" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "draft", projectId: "p1" });
  });

  it("names a first-requirements room's scope too, and says nothing over a project room", async () => {
    const first: Room = { ...row("c-first", "First requirements", "done", 56), kind: "first_requirements" };
    core([later, first]);
    const { unmount } = renderWithQuery(
      <ChatDockBody dock={dockOn({ kind: "room", projectId: "p1", conversationId: "c-first" })} />,
    );
    expect((await screen.findByTestId("subject-scope-notice")).textContent).toContain("Drafts the first requirements");
    unmount();
    renderWithQuery(<ChatDockBody dock={dockOn({ kind: "room", projectId: "p1", conversationId: "c-other" })} />);
    expect(await screen.findByTestId("chat")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("subject-scope-notice")).toBeNull();
  });
});

/** Every size the panel was asked to keep, in order. */
const kept: DockSize[] = [];
/** The docked panel beside a page column that starts after the 280px sidebar. */
function Panel({ initial = "large", window: w = 1440 }: { initial?: DockSize; window?: number }) {
  const [size, setSize] = useState<DockSize>(initial);
  const keep = (next: DockSize) => {
    kept.push(next);
    setSize(next);
  };
  const pageRef = useRef<HTMLElement | null>(null);
  const measured = (el: HTMLDivElement | null) => {
    if (el) el.getBoundingClientRect = () => ({ left: 280, right: w, width: w - 280 }) as DOMRect;
    pageRef.current = el;
  };
  return (
    <>
      <div ref={measured} />
      <ChatDock dock={{ ...dockOn({ kind: "draft", projectId: "p1" }), size, setSize: keep }} page={pageRef} />
    </>
  );
}

function docked(width: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 48rem)" && width >= 768,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const panel = () => screen.getByTestId("chat-dock");
const control = () => screen.getByTestId("chat-dock-size");
const handle = () => screen.getByTestId("chat-dock-resize");
/** The segment the switch marks as the size the panel is at, as a wide panel draws it. */
const marked = () => control().querySelector("[data-on]")?.firstChild?.textContent;
/** The size on the switch a click moves the panel to. */
const target = (size: "half" | "large") => control().querySelector<HTMLElement>(`[data-segment=${size}]`) as HTMLElement;

const openBoard = () => act(() => boardStore.load({ v: WIREFRAME_VERSION, shapes: [] }));
const closeBoard = () => act(() => boardStore.close());

function resetBoard() {
  boardStore.close();
  kept.length = 0;
}

// REQ-31 r2 (ISS-493): the docked panel opens large, the widest that leaves the page 480px; one
// control switches it to half and back and says which it is at; a drag sets any width between and
// stops at either size; the control snaps a dragged width back to one of them.
describe("the panel's two sizes", () => {
  afterEach(resetBoard);

  it("opens at large, leaving the page 480px, with no drag", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    expect(1440 - 280 - 680).toBe(480);
    expect(marked()).toBe("Large");
    expect(control().getAttribute("aria-label")).toBe("Panel size: Large");
  });

  it("draws one switch with both sizes on it and the one the panel is at marked", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    const segments = [...control().querySelectorAll("[data-segment]")].map((s) => [s.getAttribute("data-segment"), s.hasAttribute("data-on")]);
    expect(segments).toEqual([["half", false], ["large", true]]);
    expect(control().className).toContain("border");
    fireEvent.click(target("half"));
    expect([...control().querySelectorAll("[data-on]")].map((s) => s.getAttribute("data-segment"))).toEqual(["half"]);
  });

  it("switches to half of large and back with one control", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Half" }));
    expect(panel().style.width).toBe("340px");
    expect(marked()).toBe("Half");
    fireEvent.click(screen.getByRole("button", { name: "Large" }));
    expect(panel().style.width).toBe("680px");
  });

  it("is reached by keyboard: both sizes are buttons in the tab order, the one the panel is at pressed", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    const group = await screen.findByRole("group", { name: "Panel size: Large" });
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Half", "false"], ["Large", "true"]]);
    for (const b of buttons) expect(b.getAttribute("tabindex")).not.toBe("-1");
  });

  it("drags to any width between, then Half or Large snaps it to that size", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel initial="half" />);
    await waitFor(() => expect(panel().style.width).toBe("340px"));
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(panel().style.width).toBe("404px");
    expect(marked()).toBe("Custom (404 px)");
    expect(control().getAttribute("data-size")).toBe("custom");
    expect(control().getAttribute("aria-label")).toBe("Panel size: Custom (404 px)");
    fireEvent.click(target("half"));
    expect(panel().style.width).toBe("340px");
    for (let i = 0; i < 4; i++) fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(panel().style.width).toBe("596px");
    fireEvent.click(target("large"));
    expect(panel().style.width).toBe("680px");
    expect(marked()).toBe("Large");
  });

  it("stops a drag past large at large and one below half at half", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    expect(handle().getAttribute("aria-valuemin")).toBe("340");
    expect(handle().getAttribute("aria-valuemax")).toBe("680");
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(panel().style.width).toBe("680px");
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 760 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 100 });
    expect(panel().style.width).toBe("680px");
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 100 });
    expect(panel().style.width).toBe("680px");
    expect(marked()).toBe("Large");
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 760 });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1400 });
    expect(panel().style.width).toBe("340px");
    expect(marked()).toBe("Half");
  });

  it("widens to an open board, but never past large", async () => {
    core([]);
    docked(1440);
    const { unmount } = renderWithQuery(<Panel initial="half" />);
    boardStore.load({ v: WIREFRAME_VERSION, shapes: [] });
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    unmount();
    docked(2120);
    renderWithQuery(<Panel initial="half" window={2120} />);
    await waitFor(() => expect(panel().style.width).toBe("880px"));
  });

});

// REQ-31 BC-2 with a board open: the control names the width the panel is drawn at, and one click on
// a size moves the panel there at once and keeps that size, never one the person did not see
describe("the size control with a board open", () => {
  afterEach(resetBoard);

  for (const [from, w, open, name, to, toWidth] of [
    ["half", 1440, "680px", "Panel size: Large", "half", "340px"],
    ["large", 1440, "680px", "Panel size: Large", "half", "340px"],
    ["half", 1024, "360px", "Panel size: Large", "half", "180px"],
    ["large", 1024, "360px", "Panel size: Large", "half", "180px"],
    ["half", 2120, "880px", "Panel size: Board (880 px)", "half", "680px"],
    ["large", 2120, "1360px", "Panel size: Large", "half", "680px"],
  ] as const) {
    it(`names the width drawn and a click on ${to} moves it there, from ${from} at ${w}`, async () => {
      core([]);
      docked(w);
      renderWithQuery(<Panel initial={from} window={w} />);
      openBoard();
      await waitFor(() => expect(panel().style.width).toBe(open));
      expect(control().getAttribute("aria-label")).toBe(name);
      fireEvent.click(target(to));
      expect(panel().style.width).toBe(toWidth);
      expect(kept).toEqual([to]);
      closeBoard();
      expect(panel().style.width).toBe(toWidth);
    });
  }

  it("keeps switching while the board stays open, and a board opened again widens the panel again", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel initial="half" />);
    openBoard();
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    fireEvent.click(target("half"));
    expect(panel().style.width).toBe("340px");
    fireEvent.click(screen.getByRole("button", { name: "Large" }));
    expect(panel().style.width).toBe("680px");
    fireEvent.click(target("half"));
    expect(kept).toEqual(["half", "large", "half"]);
    closeBoard();
    expect(panel().style.width).toBe("340px");
    openBoard();
    expect(panel().style.width).toBe("680px");
  });

  it("draws a drag at once and keeps it", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel initial="half" />);
    openBoard();
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(panel().style.width).toBe("616px");
    expect(kept).toEqual([616]);
    expect(marked()).toBe("Custom (616 px)");
  });
});

// REQ-31 BC-2, ISS-493 r3: what the switch draws is where a click goes. Half and Large are each a
// target that moves the panel to the size it names, from every width the panel can be drawn at:
// half, large, a dragged width, and the width an open board widened it to.
describe("each size on the switch is where a click on it goes", () => {
  afterEach(resetBoard);

  const windows = [
    { w: 1440, large: 680, half: 340, custom: 530, board: 680, boardShown: "Large" },
    { w: 2120, large: 1360, half: 680, custom: 1000, board: 880, boardShown: "Board (880 px)" },
  ] as const;
  for (const win of windows) {
    const from = [
      { name: "half", initial: "half" as DockSize, board: false, drawn: win.half, shown: "Half" },
      { name: "large", initial: "large" as DockSize, board: false, drawn: win.large, shown: "Large" },
      { name: "custom", initial: win.custom as DockSize, board: false, drawn: win.custom, shown: `Custom (${win.custom} px)` },
      { name: "board", initial: "half" as DockSize, board: true, drawn: win.board, shown: win.boardShown },
    ];
    for (const f of from) {
      for (const to of ["half", "large"] as const) {
        it(`at ${win.w}, from ${f.name}, a click on ${to} draws ${to} and keeps it`, async () => {
          core([]);
          docked(win.w);
          renderWithQuery(<Panel initial={f.initial} window={win.w} />);
          if (f.board) openBoard();
          await waitFor(() => expect(panel().style.width).toBe(`${f.drawn}px`));
          const named = control().getAttribute("aria-label");
          fireEvent.click(target(to));
          const toWidth = to === "large" ? win.large : win.half;
          expect(panel().style.width).toBe(`${toWidth}px`);
          expect(kept).toEqual([to]);
          expect(named).toBe(`Panel size: ${f.shown}`);
          expect(target(to).getAttribute("aria-pressed")).toBe("true");
          expect(target(to === "large" ? "half" : "large").getAttribute("aria-pressed")).toBe("false");
          if (f.board) {
            closeBoard();
            expect(panel().style.width).toBe(`${toWidth}px`);
          }
        });
      }
    }
  }

  it("draws Custom and Board as a mark between the two, never as a target", async () => {
    core([]);
    docked(2120);
    renderWithQuery(<Panel initial={1000} window={2120} />);
    await waitFor(() => expect(panel().style.width).toBe("1000px"));
    const between = control().querySelector<HTMLElement>("[data-segment=custom]");
    expect(between?.closest("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Half|Large)$/ }).map((b) => b.textContent)).toEqual(["Half", "Large"]);
    expect(screen.queryByRole("button", { name: /Custom/ })).toBeNull();
  });
});

it("draws no size control in the full-screen panel of a phone-width window", async () => {
  core([]);
  docked(390);
  renderWithQuery(<Panel window={390} />);
  expect(await screen.findByTestId("chat-dock-body")).toBeTruthy();
  expect(screen.queryByTestId("chat-dock")).toBeNull();
  expect(screen.queryByTestId("chat-dock-size")).toBeNull();
});
