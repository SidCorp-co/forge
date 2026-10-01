// @vitest-environment jsdom
//
// ISS-34 — an approve-gate row names the type of the document that waits; "Decision" is a
// channel document type of its own, so a gate on a change request must not read as one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../types";

expect.extend(matchers);
afterEach(cleanup);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { AttentionRow } = await import("./attention-screen");

const gate = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: "channel_gate",
  title: "Publish UQ-CR-3, a change-request: Let beta sort items by date?",
  link: "/projects/alpha/ecosystem/channel/UQ-CR-3",
  since: "2026-10-01T10:00:00.000Z",
  questionId: "q1",
  documentNumber: "UQ-CR-3",
  documentType: "change-request",
  ...over,
});

describe("an approve-gate row", () => {
  it("names the waiting document's type, not Decision", () => {
    render(<AttentionRow item={gate()} onOpen={vi.fn()} />);
    expect(screen.getByText("Change request")).toBeInTheDocument();
    expect(screen.queryByText("Decision")).not.toBeInTheDocument();
  });

  it("names a decision document as one", () => {
    render(<AttentionRow item={gate({ documentType: "decision", documentNumber: "UQ-DEC-1" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });

  it("still marks an issue awaiting a decision", () => {
    render(<AttentionRow item={gate({ kind: "awaiting_input", documentType: undefined, documentNumber: undefined })} onOpen={vi.fn()} />);
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });
});
