// ISS-441: on an issue page Ask about this opens a fresh draft with nothing typed into it, because
// the issue rides to the turn as the page's record (REQ-30 BC-6); read at e523c4b0f it typed
// "About issue ISS-n: " into the draft. A run and a document are no page record, so they keep it.

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { aboutDraft } from "./ask-about";
import { AskAboutThis } from "./ask-about-this";
import { type ChatDockApi, ChatDockProvider, useChatDockState } from "./dock";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/forge/issues/ISS-441" }));

describe("Ask about this", () => {
  it("opens the issue page's draft empty, the issue being the page's record", () => {
    const { result } = renderHook(() => useChatDockState("p1"));
    act(() => result.current.askAbout(null));
    expect(result.current.open).toBe(true);
    expect(result.current.target).toEqual({ kind: "draft", projectId: "p1", draft: undefined });
  });

  it("keeps naming a run or a document in the draft, which have no page record", () => {
    expect(aboutDraft({ kind: "run", ref: "r-1" })).toBe("About run r-1: ");
    expect(aboutDraft({ kind: "document", ref: "DOC-3" })).toBe("About document DOC-3: ");
    expect(aboutDraft(null)).toBeUndefined();
  });

  it("asks about the page and names nothing", () => {
    const askAbout = vi.fn();
    const dock = { projectId: "p1", askAbout } as unknown as ChatDockApi;
    render(
      <ChatDockProvider value={dock}>
        <AskAboutThis about={null} />
      </ChatDockProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(askAbout).toHaveBeenCalledWith(null);
  });
});
