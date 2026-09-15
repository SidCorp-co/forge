// @vitest-environment jsdom
//
// ISS-1034 criteria 52, 53 — the account tab shows the answer-style control and
// the trail of every write to it, each with a restore.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreferenceChange } from "@forge/contracts";
import { AssistantPreferencesCard, describeChange } from "./assistant-preferences-card";

expect.extend(matchers);

const update = vi.fn();
const restore = vi.fn(async () => ({}));
let prefs: Record<string, unknown> | undefined;
let changes: PreferenceChange[] = [];
vi.mock("../hooks", () => ({
  useAssistantPreferences: () => ({ data: prefs, isLoading: false }),
  useUpdateAssistantPreferences: () => ({ mutate: update, isPending: false }),
  usePreferenceChanges: () => ({ data: changes, isLoading: false }),
  useRestorePreferenceChange: () => ({ mutateAsync: restore, isPending: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const CHANGE: PreferenceChange = {
  id: "ch-1",
  userId: "alice",
  field: "answer_style",
  previousValue: "default",
  newValue: "concise",
  changedBy: "assistant",
  changedByUserId: "handle-1",
  conversationId: "c1",
  changedAt: "2026-09-15T10:00:00.000Z",
};

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AssistantPreferencesCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no layout: the listbox scrolls its active option into view on open
  Element.prototype.scrollIntoView = vi.fn();
  update.mockClear();
  restore.mockClear();
  prefs = { answerStyle: "concise", assistantInstructions: "be brief" };
  changes = [CHANGE];
});
afterEach(cleanup);

describe("the answer-style control (criterion 52)", () => {
  it("shows the stored style and instructions", () => {
    renderCard();
    // the Select is a combobox whose trigger shows the chosen option's label
    expect(screen.getByLabelText("Reply style")).toHaveTextContent(/^concise/i);
    expect(screen.getByLabelText("Standing instructions")).toHaveValue("be brief");
    expect(screen.getByRole("button", { name: /save answer preferences/i })).toBeDisabled();
  });

  // cm:guard emptied instructions are sent as NULL and not as "": the server keeps `assistant_instructions` nullable and renders nothing for null, while an empty string would still render a heading over nothing (ISS-1034).
  it("saves the style and sends emptied instructions as null", () => {
    renderCard();
    fireEvent.click(screen.getByLabelText("Reply style"));
    fireEvent.click(screen.getByRole("option", { name: /^bullets/i }));
    fireEvent.change(screen.getByLabelText("Standing instructions"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: /save answer preferences/i }));
    expect(update).toHaveBeenCalledWith({ answerStyle: "bullets", assistantInstructions: null });
  });
});

describe("the trail (criterion 53)", () => {
  it("lists each change as a sentence naming the field, the value and who wrote it", () => {
    renderCard();
    expect(screen.getByTestId("preference-changes")).toHaveTextContent(
      "Reply style set to “concise” by the assistant, in a conversation",
    );
    expect(describeChange({ ...CHANGE, field: "assistant_instructions", newValue: null, changedBy: "admin" })).toBe(
      "Standing instructions cleared by an org admin",
    );
  });

  it("offers a restore on each row and sends the row's id", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /^restore: reply style/i }));
    expect(restore).toHaveBeenCalledWith("ch-1");
  });

  it("says so when nothing has been changed", () => {
    changes = [];
    renderCard();
    expect(screen.getByText(/nothing has been changed yet/i)).toBeInTheDocument();
  });
});
