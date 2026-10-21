// REQ-11 r4 BC-8: the phone's slide-over covers the page, so a page opened from inside it is shown with
// the slide-over closed; anywhere wider the dock stays open across pages (dock-stays-open.test.tsx).

import { QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatDockApi } from "@/features/chat-dock";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ChatDock } from "./chat-dock";

const nav = vi.hoisted(() => ({ path: "/projects/forge/requirements" }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ usePathname: () => nav.path }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("../board/board-panel", () => ({ BOARD_DOCK_WIDTH: 880, DockBoard: () => null }));
vi.mock("./conversation-chat", () => ({ ConversationChat: () => <div data-testid="chat" /> }));

afterEach(() => vi.unstubAllGlobals());

function phone() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  fakeCore(({ path }) => {
    if (path === "/projects") return { body: [{ id: "p1", name: "forge", slug: "forge" }] };
    if (path.startsWith("/conversations?")) return { body: { items: [], total: 0 } };
    return undefined;
  });
}

function dockApi(close: () => void): ChatDockApi {
  const noop = () => {};
  return { projectId: "p1", open: true, target: { kind: "draft", projectId: "p1" }, keptRoom: null, generation: 0, size: "large", setSize: noop, show: noop, close, toggle: noop, select: noop, follow: noop, askAbout: noop, setDoor: noop };
}

it("closes the slide-over when a page opens under it, and not before", async () => {
  phone();
  const close = vi.fn();
  const page = { current: null };
  const view = renderWithQuery(<ChatDock dock={dockApi(close)} page={page} />);
  expect(await screen.findByTestId("chat-dock-body")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  nav.path = "/projects/forge/requirements/REQ-43";
  view.rerender(
    <QueryClientProvider client={view.client}>
      <ChatDock dock={dockApi(close)} page={page} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});
