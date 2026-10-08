import type { ShareAudienceOption } from "@forge/contracts/shares";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

// Share sits in an answer's own row beside Copy, and only on an answer that holds something to
// share: a report block, shared as the message, or a template's output, shared as its template and
// runs in order. Prose, a person's turn and a room with no project offer nothing.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = "11111111-1111-4111-8111-111111111111";

const block = {
  v: 1,
  kind: "status-list",
  ref: "key",
  status: "state",
  source: { runId: "run-9" },
  frame: {
    fields: [
      { name: "key", type: "ref", label: "Item" },
      { name: "state", type: "status", label: "State" },
    ],
    rows: [{ key: "REQ-4", state: "agreed" }],
  },
};


const said = (id: string, role: "assistant" | "user", blocks: unknown[] | null, content = "Here it is."): ConversationMessage =>
  ({
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    role,
    authorUserId: null,
    authorLabel: null,
    content,
    blocks,
    silenceReason: null,
    createdAt: "2026-10-08T03:47:00Z",
  }) as unknown as ConversationMessage;


const window1: ConversationWindow = { id: "w1", firstSeq: 1, lastSeq: 9, closedAt: "2026-10-08T03:48:00Z", decision: null, decisionDetail: null };

const templateCall = (output: unknown, isError = false) => ({
  type: "tool",
  toolCall: { id: "c1", name: "forge_template", input: { templateId: "progress" }, output: JSON.stringify(output), ...(isError ? { isError } : {}) },
});

const open = (audience: ShareAudienceOption["audience"]): ShareAudienceOption => ({ audience, refusal: null });

/** A core answering the audiences read and a create. */
function dialogCore() {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === `/projects/${P}/shares/audiences`) return { body: { audiences: [open("members"), open("link")] } };
    if (call.method === "POST" && call.path === `/projects/${P}/shares`) {
      return {
        status: 201,
        body: {
          share: { id: "s-1", projectId: P, audience: "members", subjectKind: "template-output", title: null, createdBy: "u", createdAt: "2026-10-08T03:50:00.000Z", expiresAt: "2026-10-15T03:50:00.000Z", revokedAt: null, revokedBy: null, viewCount: 0, lastViewedAt: null },
          url: `https://forge.test/s/forge_share_${"t".repeat(43)}`,
        },
      };
    }
    return undefined;
  });
}

const createButton = () => screen.getByRole("button", { name: "Create link" });

describe("the Share action on an answer", () => {
  const thread = (messages: ConversationMessage[], projectId: string | null = P) =>
    renderWithQuery(<ConversationThread projectId={projectId ?? undefined} projectSlug="forge-dev" messages={messages} windows={[window1]} />);

  it("shows on an answer holding a report block, and on no answer without one", () => {
    thread([
      said("m1", "user", null, "How far along are we?"),
      said("m2", "assistant", [{ type: "text", text: "Plain words." }]),
      said("m3", "assistant", [{ type: "visual", visual: block }]),
    ]);
    const shares = screen.getAllByTestId("message-share");
    expect(shares).toHaveLength(1);
    expect(shares[0]?.getAttribute("data-subject-kind")).toBe("message");
    const rows = screen.getAllByTestId("message-actions");
    expect(within(rows[2] as HTMLElement).getByTestId("message-share")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByTestId("message-share")).toBeNull();
    expect(within(rows[0] as HTMLElement).queryByTestId("message-share")).toBeNull();
  });

  it("shares a turn that ran a template as its output, named by template and runs in order", async () => {
    const calls = dialogCore();
    thread([
      said("m4", "assistant", [
        templateCall({ document: { templateId: "progress", runs: [{ runId: "r-a" }, { runId: "r-b" }] } }),
        { type: "text", text: "The report." },
      ]),
      said("m5", "assistant", [templateCall({ document: { templateId: "progress", runs: [{ runId: "r-c" }] } }, true)]),
      said("m6", "assistant", [templateCall("not a document")]),
    ]);
    const shares = screen.getAllByTestId("message-share");
    expect(shares).toHaveLength(1);
    expect(shares[0]?.getAttribute("data-subject-kind")).toBe("template-output");
    fireEvent.click(shares[0] as HTMLElement);
    await waitFor(() => expect(createButton()).toBeEnabled());
    fireEvent.click(createButton());
    await screen.findByTestId("share-created");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      subjectKind: "template-output",
      subjectId: "progress:r-a,r-b",
      audience: "members",
      expiresInDays: 7,
    });
  });

  it("offers nothing where the room names no project to share from", () => {
    thread([said("m3", "assistant", [{ type: "visual", visual: block }])], null);
    expect(screen.queryByTestId("message-share")).toBeNull();
  });
});
