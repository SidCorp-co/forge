// ISS-1325 c1, c4: a box's live view opens full screen from the Boxes page. The browser's full screen is
// asked on the box's screen, and where it is refused the screen fills the viewport instead; a small
// bar keeps who holds it, the frame rate, Take control or Hand back and Exit; Esc, the browser's own
// way out and Exit leave it. Take control and the holder's input go through the page's own doors and
// input socket. Core, the sockets and the Fullscreen API are stood in for, so no test reaches a box.

import { BOX_ROUTES } from "@forge/contracts/boxes";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxCore, FakeSocket, inputSent, routeOf, sayHello } from "@/test/box-sockets";
import { BOX, ME, PROJECT_ID, projectBoxes } from "@/test/boxes";
import { renderWithQuery } from "@/test/render";
import { BoxesScreen } from "./boxes-screen";

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));

/** The browser's Fullscreen API: `grant` says whether it shows the element or refuses it. */
function fullscreenApi(grant: boolean) {
  let shown: Element | null = null;
  const changed = () => document.dispatchEvent(new Event("fullscreenchange"));
  const request = vi.fn(() => {
    if (!grant) return Promise.reject(new TypeError("Permissions check failed"));
    shown = document.querySelector("[data-testid=box-screen]");
    changed();
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    shown = null;
    changed();
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => shown });
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  /** The browser's own way out: Esc, or its exit gesture. */
  const browserLeaves = () =>
    act(() => {
      shown = null;
      changed();
    });
  return { request, exit, browserLeaves };
}

const selectBox = (id: string) => window.history.replaceState(null, "", `/projects/orvio/boxes?box=${id}`);

async function openFull() {
  fireEvent.click(await screen.findByRole("button", { name: "Full screen" }));
  return screen.findByTestId("box-screen");
}

beforeEach(() => {
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  for (const name of ["exitFullscreen", "fullscreenElement", "fullscreenEnabled"]) Reflect.deleteProperty(document, name);
  Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
});

describe("a box's live view in full screen", () => {
  it("asks the browser's full screen on the box's screen, keeps the bar, and leaves by Exit and by the browser's own way out", async () => {
    const api = fullscreenApi(true);
    boxCore(projectBoxes());
    selectBox(BOX.admin);
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const full = await openFull();
    await waitFor(() => expect(full).toHaveAttribute("data-mode", "native"));
    expect(api.request.mock.contexts[0]).toBe(full);
    // the page's own view let go: the one view drawn is the screen's, as large as the display takes it
    expect(screen.getAllByTestId("box-view").map((v) => v.dataset.fit)).toEqual(["screen"]);
    const bar = within(screen.getByTestId("box-screen-bar"));
    expect(bar.getByText("ISS-7 · Shift report (admin)")).toBeTruthy();
    expect(bar.getByText("Agent")).toBeTruthy();
    expect(bar.getByRole("combobox", { name: "Frame rate" })).toBeTruthy();
    expect(bar.getByRole("button", { name: "Take control" })).toBeTruthy();
    // the browser already shows it full screen: no second way in
    expect(bar.queryByRole("button", { name: "Full screen" })).toBeNull();

    fireEvent.click(bar.getByRole("button", { name: "Exit" }));
    expect(api.exit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("box-screen")).toBeNull());
    expect(screen.getAllByTestId("box-view").map((v) => v.dataset.fit)).toEqual(["page"]);

    await openFull();
    await waitFor(() => expect(screen.getByTestId("box-screen")).toHaveAttribute("data-mode", "native"));
    api.browserLeaves();
    await waitFor(() => expect(screen.queryByTestId("box-screen")).toBeNull());
  });

  it("fills the viewport where the browser refuses full screen or has none, and Esc leaves it without reaching the box", async () => {
    const api = fullscreenApi(false);
    boxCore(projectBoxes(Date.now(), true));
    selectBox(BOX.held);
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const full = await openFull();
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    expect(full).toHaveAttribute("data-mode", "fill");
    // filling the viewport, it still offers the browser's full screen, a press away
    expect(within(screen.getByTestId("box-screen-bar")).getByRole("button", { name: "Full screen" })).toBeTruthy();
    sayHello(BOX.held, 390, 844);
    const layer = await within(full).findByTestId("box-input");
    await waitFor(() => expect(FakeSocket.opened.some((s) => s.url.includes("/ws/boxes/input"))).toBe(true));
    fireEvent.keyDown(layer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("box-screen")).toBeNull());
    expect(inputSent()).toEqual([]);

    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    const again = await openFull();
    await act(() => Promise.resolve());
    expect(again).toHaveAttribute("data-mode", "fill");
  });

  it("takes control from full screen with the take route, and the holder's input there goes on the input socket as on the page", async () => {
    fullscreenApi(true);
    const calls = boxCore(projectBoxes(), (c) =>
      c.method === "POST" && c.path === routeOf(BOX_ROUTES.take, BOX.admin) ? { body: { box: { ...projectBoxes().find((b) => b.id === BOX.admin), state: "person", holder: { kind: "person", userId: ME, name: "Me" }, heldSince: new Date().toISOString() } } } : undefined,
    );
    selectBox(BOX.admin);
    const first = renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    await openFull();
    fireEvent.click(within(screen.getByTestId("box-screen-bar")).getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === routeOf(BOX_ROUTES.take, BOX.admin))).toBe(true));
    first.unmount();

    FakeSocket.opened = [];
    const again = boxCore(projectBoxes(Date.now(), true));
    selectBox(BOX.held);
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const full = await openFull();
    expect(within(screen.getByTestId("box-screen-bar")).getByRole("button", { name: "Hand back" })).toBeTruthy();
    expect(within(screen.getByTestId("box-screen-bar")).getByTestId("box-held-by").textContent).toMatch(/^You since \d{1,2}:\d{2}/);
    sayHello(BOX.held, 390, 844);
    const layer = await within(full).findByTestId("box-input");
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844, x: 0, y: 0, toJSON: () => ({}) });
    layer.setPointerCapture = () => undefined;
    // the holder's input socket, entered with its own input ticket, is the page's
    await waitFor(() => expect(FakeSocket.opened.some((s) => s.url.includes("/ws/boxes/input"))).toBe(true));
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 195, clientY: 422 });
    fireEvent.keyDown(layer, { key: "a" });
    expect(inputSent()).toEqual([
      { t: "pointer", action: "down", x: 0.5, y: 0.5 },
      { t: "text", text: "a" },
    ]);
    expect(again.some((c) => c.method === "POST" && c.path === routeOf(BOX_ROUTES.ticket, BOX.held) && (c.body as { channel?: string }).channel === "input")).toBe(true);
  });
});
