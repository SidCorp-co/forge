// REQ-31 r2 (ISS-493): the docked panel's sizes — large, half and a dragged width between — and the
// control that switches them. Half never draws under 360px; where large sits there too, no Half is
// offered and the control says why (decided 2026-10-14 on ISS-493).

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIREFRAME_VERSION } from "@forge/contracts/wireframe";
import { boardStore } from "@/features/board";
import type { ChatDockApi, ChatTarget, DockSize } from "@/features/chat-dock";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ChatDock } from "./chat-dock";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ usePathname: () => "/projects/epod/requirements" }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("../board/board-panel", () => ({ BOARD_DOCK_WIDTH: 880, DockBoard: () => <div data-testid="board" /> }));
vi.mock("./conversation-chat", () => ({
  ConversationChat: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="chat" data-conversation={conversationId ?? "new"} />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const project = { id: "p1", name: "epod", slug: "epod" };

/** No conversations: every panel here opens a draft, never a room. */
function core(rooms: []) {
  return fakeCore(({ path }) => {
    if (path === "/projects") return { body: [project] };
    if (path.startsWith("/conversations?")) return { body: { items: rooms, total: rooms.length } };
    return undefined;
  });
}

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

  it("switches to half of large, held at 360px, and back with one control", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Half" }));
    expect(panel().style.width).toBe("360px");
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
    await waitFor(() => expect(panel().style.width).toBe("360px"));
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(panel().style.width).toBe("424px");
    expect(marked()).toBe("Custom (424 px)");
    expect(control().getAttribute("data-size")).toBe("custom");
    expect(control().getAttribute("aria-label")).toBe("Panel size: Custom (424 px)");
    fireEvent.click(target("half"));
    expect(panel().style.width).toBe("360px");
    for (let i = 0; i < 4; i++) fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(panel().style.width).toBe("616px");
    fireEvent.click(target("large"));
    expect(panel().style.width).toBe("680px");
    expect(marked()).toBe("Large");
  });

  it("stops a drag past large at large and one below half at half", async () => {
    core([]);
    docked(1440);
    renderWithQuery(<Panel />);
    await waitFor(() => expect(panel().style.width).toBe("680px"));
    expect(handle().getAttribute("aria-valuemin")).toBe("360");
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
    expect(panel().style.width).toBe("360px");
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
    ["half", 1440, "680px", "Panel size: Large", "half", "360px"],
    ["large", 1440, "680px", "Panel size: Large", "half", "360px"],
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
    expect(panel().style.width).toBe("360px");
    fireEvent.click(screen.getByRole("button", { name: "Large" }));
    expect(panel().style.width).toBe("680px");
    fireEvent.click(target("half"));
    expect(kept).toEqual(["half", "large", "half"]);
    closeBoard();
    expect(panel().style.width).toBe("360px");
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

// REQ-31, decided 2026-10-14 on ISS-493 (question 7f3f19ed, answer a): Half never goes below 360px, and
// where large is at 360 the switch offers no Half and says why, rather than a 180px panel whose own
// title shrinks to nothing
describe("a window where large is at 360px", () => {
  afterEach(resetBoard);

  it("offers no Half, says why, and marks Large", async () => {
    core([]);
    docked(1024);
    renderWithQuery(<Panel window={1024} />);
    await waitFor(() => expect(panel().style.width).toBe("360px"));
    expect(screen.queryByRole("button", { name: "Half" })).toBeNull();
    expect(screen.getByTestId("chat-dock-no-half").textContent).toBe("No Half: window too narrow");
    expect(screen.getByRole("button", { name: "Large" }).getAttribute("aria-pressed")).toBe("true");
    expect(control().getAttribute("aria-label")).toBe("Panel size: Large");
  });

  it("draws a Half this browser kept at large's 360px, never 180px", async () => {
    core([]);
    docked(1024);
    renderWithQuery(<Panel initial="half" window={1024} />);
    await waitFor(() => expect(panel().style.width).toBe("360px"));
    expect(marked()).toBe("Large");
    expect(screen.queryByRole("button", { name: "Half" })).toBeNull();
  });

  it("keeps large on a drag, with nothing between to drag to", async () => {
    core([]);
    docked(1024);
    renderWithQuery(<Panel window={1024} />);
    await waitFor(() => expect(panel().style.width).toBe("360px"));
    expect(handle().getAttribute("aria-valuemin")).toBe("360");
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(panel().style.width).toBe("360px");
    expect(kept).toEqual(["large"]);
  });

  it("offers Half again at 360px once large is wider than 360px", async () => {
    core([]);
    docked(1200);
    renderWithQuery(<Panel window={1200} />);
    await waitFor(() => expect(panel().style.width).toBe("440px"));
    fireEvent.click(screen.getByRole("button", { name: "Half" }));
    expect(panel().style.width).toBe("360px");
    expect(marked()).toBe("Half");
  });
});

// REQ-31 BC-2, ISS-493 r3: what the switch draws is where a click goes. Half and Large are each a
// target that moves the panel to the size it names, from every width the panel can be drawn at:
// half, large, a dragged width, and the width an open board widened it to.
describe("each size on the switch is where a click on it goes", () => {
  afterEach(resetBoard);

  const windows = [
    { w: 1440, large: 680, half: 360, custom: 530, board: 680, boardShown: "Large" },
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
