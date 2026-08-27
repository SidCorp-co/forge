// @vitest-environment jsdom
//
// ISS-718 — the composer's model picker. The behaviour worth a test is the
// three-state pick: "untouched" must show the session's persisted model, and
// "Default" must be selectable as a distinct choice rather than collapsing into
// untouched (which would make going back to the runner default impossible).
// Matchers are extended on vitest's OWN `expect` (see composer-slash.test.tsx).

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelTier } from "../types";
import { ModelPicker } from "./model-picker";

expect.extend(matchers);

afterEach(cleanup);

function renderPicker(
  over: {
    activeModel?: ModelTier | null;
    pendingModel?: ModelTier | null | undefined;
    disabled?: boolean;
    loading?: boolean;
  } = {},
) {
  const onSelect = vi.fn();
  render(
    <ModelPicker
      activeModel={over.activeModel ?? null}
      pendingModel={over.pendingModel}
      onSelect={onSelect}
      disabled={over.disabled}
      loading={over.loading}
    />,
  );
  return { onSelect };
}

function trigger() {
  return screen.getByRole("button", { name: /Model this conversation runs on|Default|Haiku|Sonnet|Opus/ });
}

describe("ModelPicker", () => {
  it("labels the trigger Default when the session never picked one", () => {
    renderPicker();
    expect(trigger()).toHaveTextContent("Default");
  });

  it("labels the trigger with the session's persisted model", () => {
    renderPicker({ activeModel: "sonnet" });
    expect(trigger()).toHaveTextContent("Sonnet");
  });

  it("a pending pick wins over the persisted one", () => {
    renderPicker({ activeModel: "sonnet", pendingModel: "opus" });
    expect(trigger()).toHaveTextContent("Opus");
  });

  it("a pending null reads as Default, not as the persisted model", () => {
    renderPicker({ activeModel: "opus", pendingModel: null });
    expect(trigger()).toHaveTextContent("Default");
  });

  it("offers every tier plus Default, with the effective one checked", () => {
    renderPicker({ activeModel: "haiku" });
    fireEvent.click(trigger());
    // cm:why the label is the row's first inner span; the sub-line follows it in textContent, so reading textContent whole would concatenate the two
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((r) => r.querySelector("span > span")?.textContent)).toEqual([
      "Default",
      "Haiku",
      "Sonnet",
      "Opus",
    ]);
    expect(screen.getByRole("menuitemradio", { name: /^Haiku/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("reports null when Default is chosen, so the caller can clear the pick", () => {
    const { onSelect } = renderPicker({ activeModel: "opus" });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Default/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("reports the tier that was chosen", () => {
    const { onSelect } = renderPicker();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Opus/ }));
    expect(onSelect).toHaveBeenCalledWith("opus");
  });

  it("says a pick has not taken effect yet, and stops once it has", () => {
    const unsent = "Applies from your next message.";
    renderPicker({ activeModel: "haiku", pendingModel: "opus" });
    fireEvent.click(trigger());
    expect(screen.getByText(unsent)).toBeInTheDocument();

    cleanup();
    // cm:why the same tier already persisted means nothing is pending, so the claim must be absent
    renderPicker({ activeModel: "opus", pendingModel: "opus" });
    fireEvent.click(trigger());
    expect(screen.queryByText(unsent)).not.toBeInTheDocument();
  });

  it("shows a placeholder rather than a wrong label while the session loads", () => {
    renderPicker({ activeModel: "opus", loading: true });
    expect(screen.queryByText("Opus")).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Model this conversation runs on/ });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a viewer sees the model but cannot open the menu", () => {
    renderPicker({ activeModel: "sonnet", disabled: true });
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Escape closes the menu", () => {
    renderPicker();
    fireEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
