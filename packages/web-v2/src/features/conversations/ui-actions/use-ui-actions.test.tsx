// A ui_* call moves the browser of the person the turn answers, and nobody else's (REQ-32 criterion
// 6). Core sends a turn's live tool calls to its asker alone, so a call is applied when it arrives in
// the live turn; one first read off a settled row — another member's turn — is shown, never applied.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage, ConversationProgressEntry } from "../types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/projects/demo",
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-asker" } }) }));

const { useUiActions } = await import("./use-ui-actions");

const call = {
  id: "call-1",
  name: "ui_navigate",
  input: { route: "issues" },
  output: JSON.stringify({ action: { name: "ui.navigate", params: { route: "issues" } } }),
};

const live: ConversationProgressEntry = {
  conversationId: "c1",
  rev: 2,
  view: "asker",
  entry: { id: "e1", type: "assistant", timestamp: 0, content: "", blocks: [{ type: "tool", toolCall: call }] },
};

const settledRow: ConversationMessage = {
  id: "e1",
  seq: 2,
  role: "assistant",
  authorUserId: "h-1",
  authorLabel: "forge",
  content: "Opened the issues.",
  blocks: [{ type: "tool", toolCall: call }, { type: "text", text: "Opened the issues." }],
  silenceReason: null,
  createdAt: "2026-10-08T03:46:00Z",
};

type Args = Parameters<typeof useUiActions>[0];
const base: Args = { slug: "demo", ready: true, messages: [], progress: null };

beforeEach(() => push.mockClear());

describe("a ui call", () => {
  it("is applied in the browser that receives it in the live turn", () => {
    const { rerender } = renderHook((a: Args) => useUiActions(a), { initialProps: base });
    rerender({ ...base, progress: live });
    expect(push).toHaveBeenCalledWith("/projects/demo/issues");
    rerender({ ...base, progress: live, messages: [settledRow] });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("first read off a settled row is shown, and moves nobody's browser", () => {
    const { rerender, result } = renderHook((a: Args) => useUiActions(a), { initialProps: base });
    rerender({ ...base, messages: [settledRow] });
    expect(push).not.toHaveBeenCalled();
    expect(result.current.cardsFor("e1")).not.toBeNull();
  });
});
