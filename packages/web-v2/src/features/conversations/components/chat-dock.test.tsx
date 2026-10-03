// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "alpha", name: "Alpha" }], isLoading: false }),
}));
vi.mock("@/features/ecosystem/hooks", () => ({ useProjectEcosystems: () => ({ data: undefined }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("../hooks", () => ({ useConversation: () => ({ data: undefined }) }));
vi.mock("./conversation-chat", () => ({
  ConversationChat: ({ projectId, initialDraft }: { projectId: string; initialDraft?: string }) => (
    <div data-testid="chat" data-project={projectId} data-draft={initialDraft ?? ""} />
  ),
}));
vi.mock("./conversation-list", () => ({ ConversationList: () => <div data-testid="list" /> }));
vi.mock("./start-conversation", () => ({ StartConversation: () => <div data-testid="start" /> }));

const { ChatDock } = await import("./chat-dock");
const { DOCK_WIDTH_KEY, useChatDockState } = await import("../dock");

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

function Harness({ projectId }: { projectId: string | null }) {
  const dock = useChatDockState(projectId);
  return (
    <>
      <button type="button" onClick={dock.toggle}>toggle</button>
      <button type="button" onClick={() => dock.askAbout("issue", "ISS-7")}>ask</button>
      <ChatDock dock={dock} />
    </>
  );
}

describe("the chat dock", () => {
  it("is closed until toggled, opens on the selected project, and closes from its own header", () => {
    render(<Harness projectId="p1" />);
    expect(screen.queryByTestId("chat-dock")).toBeNull();
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-project", "p1");
    fireEvent.click(screen.getByRole("button", { name: "Close Ask Agent" }));
    expect(screen.queryByTestId("chat-dock")).toBeNull();
  });

  it("opens with the object named first when asked about it", () => {
    render(<Harness projectId="p1" />);
    fireEvent.click(screen.getByText("ask"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-draft", "About issue ISS-7: ");
  });

  it("has no tab strip: past conversations open from the history button", () => {
    render(<Harness projectId="p1" />);
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.queryByRole("button", { name: "Chats" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Context" })).toBeNull();
    expect(screen.queryByTestId("list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Past conversations" }));
    expect(screen.getByTestId("list")).toBeInTheDocument();
  });

  it("resizes by keyboard within its bounds, and the next visit reopens it at that width", () => {
    const view = render(<Harness projectId="p1" />);
    fireEvent.click(screen.getByText("toggle"));
    const handle = screen.getByTestId("chat-dock-resize");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    // jsdom's window is 1024 wide, under 1300, so the panel opens at 380 (ISS-63)
    expect(screen.getByTestId("chat-dock")).toHaveStyle({ width: "444px" });
    expect(window.localStorage.getItem(DOCK_WIDTH_KEY)).toBe("444");
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(screen.getByTestId("chat-dock")).toHaveStyle({ width: "900px" });
    view.unmount();
    render(<Harness projectId="p1" />);
    expect(screen.getByTestId("chat-dock")).toHaveStyle({ width: "900px" });
  });

  it("still works when storage refuses every read and write", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useChatDockState("p1"));
    act(() => result.current.toggle());
    act(() => result.current.setWidth(600));
    expect(result.current.open).toBe(true);
    expect(result.current.width).toBe(600);
    get.mockRestore();
    set.mockRestore();
  });

  it("follows the selected project: another project's room gives way to a draft there", () => {
    const { result, rerender } = renderHook(({ p }) => useChatDockState(p), { initialProps: { p: "p1" } });
    act(() => result.current.select({ kind: "room", projectId: "p1", conversationId: "c1" }));
    expect(result.current.target).toEqual({ kind: "room", projectId: "p1", conversationId: "c1" });
    rerender({ p: "p2" });
    expect(result.current.target).toEqual({ kind: "draft", projectId: "p2" });
  });
});
