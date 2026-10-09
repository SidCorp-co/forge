import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

// The live QA of ISS-422 (2026-10-08): nothing in the web saved a template run the Assistant made,
// so a person could keep the report only over REST. An answer that ran a template now offers Save
// report beside Copy and Share; it keeps the template's runs in order with the narrative the turn
// wrote, links the kept report, and reads core's refusal where core refuses.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = "11111111-1111-4111-8111-111111111111";

const said = (id: string, blocks: unknown[] | null, role: "assistant" | "user" = "assistant"): ConversationMessage =>
  ({
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    role,
    authorUserId: null,
    authorLabel: null,
    content: "Here it is.",
    blocks,
    silenceReason: null,
    createdAt: "2026-10-08T03:47:00Z",
  }) as unknown as ConversationMessage;

const window1: ConversationWindow = { id: "w1", firstSeq: 1, lastSeq: 9, closedAt: "2026-10-08T03:48:00Z", decision: null, decisionDetail: null };

const templateCall = (narrative: Record<string, string> = {}) => ({
  type: "tool",
  toolCall: {
    id: "c1",
    name: "forge_template",
    input: { templateId: "progress" },
    output: JSON.stringify({ document: { templateId: "progress", runs: [{ runId: "r-a" }, { runId: "r-b" }], narrative } }),
  },
});

const thread = (messages: ConversationMessage[]) =>
  renderWithQuery(<ConversationThread projectId={P} projectSlug="forge-dev" messages={messages} windows={[window1]} />);

describe("Save report on a chat answer", () => {
  it("shows only on an answer that ran a template", () => {
    thread([said("m1", null, "user"), said("m2", [{ type: "text", text: "Plain words." }]), said("m3", [templateCall()])]);
    const rows = screen.getAllByTestId("message-actions");
    expect(screen.getAllByTestId("message-save-report")).toHaveLength(1);
    expect(within(rows[2] as HTMLElement).getByTestId("message-save-report")).toBeInTheDocument();
  });

  it("keeps the template's runs in order with the slots the turn wrote, and links the kept report", async () => {
    const calls = fakeCore((call) =>
      call.method === "POST" && call.path === `/projects/${P}/status/reports`
        ? { status: 201, body: { id: "rep-1", projectId: P, asOf: "2026-10-08T03:50:00Z", days: null, template: { id: "progress", title: "Progress" }, period: null, producer: { kind: "person", user: null, schedule: null } } }
        : undefined,
    );
    thread([said("m3", [templateCall({ summary: "Two of three requirements are proven.", risks: "" })])]);
    fireEvent.click(screen.getByTestId("message-save-report"));
    const kept = await screen.findByTestId("message-report-saved");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      templateId: "progress",
      runIds: ["r-a", "r-b"],
      narrative: { summary: "Two of three requirements are proven." },
      findings: [],
    });
    expect(kept.getAttribute("href")).toBe("/projects/forge-dev/status?tab=history&report=rep-1");
  });

  it("reads core's refusal by name and keeps nothing", async () => {
    fakeCore(() => ({
      status: 422,
      body: {
        code: "REPORT_RUN_NOT_FOUND",
        message: "refused",
        error: { code: "REPORT_RUN_NOT_FOUND", message: "refused", refusals: [{ code: "REPORT_RUN_NOT_FOUND", path: "/runId", detail: "no report run r-a is kept" }] },
      },
    }));
    thread([said("m3", [templateCall()])]);
    fireEvent.click(screen.getByTestId("message-save-report"));
    await waitFor(() => expect(screen.getByTestId("message-save-refusal")).toHaveTextContent("REPORT_RUN_NOT_FOUND"));
    expect(screen.getByTestId("message-save-refusal")).toHaveTextContent("no report run r-a is kept");
    expect(screen.queryByTestId("message-report-saved")).toBeNull();
  });
});
