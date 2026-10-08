// ISS-441: the issue page's Ask about this opens a fresh draft with no issue key typed into it; the
// issue reaches the turn as the page's record (REQ-30 BC-6). Read at e523c4b0f it typed
// "About issue ISS-n: " into the draft.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type ChatDockApi, ChatDockProvider, useChatDockState } from "@/features/chat-dock/dock";
import { renderWithQuery } from "@/test/render";
import type { IssueDetail } from "../../types";
import { IssueActions } from "./issue-actions";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge/issues/ISS-441",
  useRouter: () => ({ push: () => undefined }),
}));

describe("the issue header's Ask about this", () => {
  it("opens a draft with no issue key typed into it", () => {
    let dock: ChatDockApi | null = null;
    function Page() {
      const state = useChatDockState("p1");
      dock = state;
      const issue = { id: "i-1", displayId: "ISS-441", status: "in_progress" } as unknown as IssueDetail;
      return (
        <ChatDockProvider value={state}>
          <IssueActions
            issue={issue}
            slug="forge"
            linkId="ISS-441"
            canWrite={false}
            pending={false}
            start={{ kind: "none" }}
            isRunActive={false}
            exitsHere={[]}
            onTransition={() => undefined}
            onStarted={() => undefined}
          />
        </ChatDockProvider>
      );
    }
    renderWithQuery(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    const opened = (dock as ChatDockApi | null)?.target;
    expect(opened).toEqual({ kind: "draft", projectId: "p1", draft: undefined });
    expect(JSON.stringify(opened)).not.toContain("ISS-441");
  });
});
