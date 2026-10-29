// REQ-47 BC-10 (ISS-746): "Your feedback to Forge" shows, on an opened item, what its triage told the
// person — the answer, the decline note, the clarification asked and the release its fix shipped in —
// and nothing where it told nothing.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { MyForgeFeedback } from "./my-forge-feedback";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const NONE = { answer: null, declined: null, clarification: null, shippedIn: null };
const ITEM = (key: string, told: Record<string, unknown>) => ({
  key,
  title: `item ${key}`,
  kind: "question",
  severity: "medium",
  phase: "triaged",
  route: null,
  origin: null,
  createdAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T08:00:00.000Z",
  progress: { says: "Answered.", running: false, eta: { estimate: false } },
  shipEvidence: null,
  told: { ...NONE, ...told },
});

function serve(items: unknown[]) {
  fakeCore((c) =>
    c.method === "GET" && c.path === "/forge/feedback"
      ? { body: { feedback: items, returned: items.length, home: { id: "h", slug: "forge", name: "Forge" }, asOf: "2026-10-21T08:00:00.000Z" } }
      : undefined,
  );
}

async function open(key: string) {
  const user = userEvent.setup();
  renderWithQuery(<MyForgeFeedback />);
  await user.click(await screen.findByText(`item ${key}`));
}

const told = (which: string) => screen.queryByTestId(`my-forge-feedback-told-${which}`)?.textContent ?? null;

describe("Your feedback to Forge", () => {
  it("shows what triage told the person on the opened item", async () => {
    serve([
      ITEM("FB-1", {
        answer: "It is by design.",
        clarification: { prompt: "Which command failed?", recommended: "forge claim", status: "open" },
        shippedIn: "0.4.0-dev.330",
      }),
    ]);
    await open("FB-1");
    expect(told("answer")).toBe("AnswerIt is by design.");
    expect(told("asked")).toBe("AskedWhich command failed?");
    expect(told("shippedIn")).toBe("Shipped in0.4.0-dev.330");
    expect(told("declined")).toBeNull();
  });

  it("shows the decline note", async () => {
    serve([ITEM("FB-2", { declined: "Not ours to change." })]);
    await open("FB-2");
    expect(told("declined")).toBe("DeclinedNot ours to change.");
  });

  it("shows nothing told where triage told nothing", async () => {
    serve([ITEM("FB-3", {})]);
    await open("FB-3");
    expect(screen.queryByTestId("my-forge-feedback-told")).toBeNull();
  });
});
