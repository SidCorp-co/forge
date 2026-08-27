// @vitest-environment jsdom
//
// ISS-718 — the composer's `/` menu and inline actions slot, mounted for real.
// Matchers are extended on vitest's OWN `expect` (not the
// `@testing-library/jest-dom/vitest` convenience entry) because that entry
// resolves its own vitest peer, which under pnpm hoisting can land on a
// different vitest than the one running this file.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokableSkill } from "@/features/skills/types";
import { Composer } from "./composer";

expect.extend(matchers);

afterEach(cleanup);

const SKILLS: InvokableSkill[] = [
  { name: "forge-code", description: "Implement the plan" },
  { name: "forge-drive", description: "Drive one issue end to end" },
  { name: "dataviz", description: "Charts that read as one system" },
];

function renderComposer(
  over: {
    items?: InvokableSkill[];
    loading?: boolean;
    error?: unknown;
    onSend?: (m: string, f: File[]) => Promise<void>;
    withSkills?: boolean;
    actions?: React.ReactNode;
  } = {},
) {
  const onSend = over.onSend ?? vi.fn(async () => undefined);
  const retry = vi.fn();
  const slashSkills =
    over.withSkills === false
      ? undefined
      : {
          items: over.items ?? SKILLS,
          loading: over.loading ?? false,
          error: over.error ?? null,
          retry,
        };
  const view = render(
    <Composer onSend={onSend} allowAttachments actions={over.actions} slashSkills={slashSkills} />,
  );
  return { ...view, onSend, retry };
}

function textarea() {
  return screen.getByLabelText("Message") as HTMLTextAreaElement;
}

/** Type `text` the way a user would: value + caret, then fire `change`. */
function typeInto(el: HTMLTextAreaElement, text: string) {
  fireEvent.change(el, { target: { value: text, selectionStart: text.length } });
}

describe("Composer — slash skills menu", () => {
  it("opens on a slash token and lists the project's skills", () => {
    renderComposer();
    typeInto(textarea(), "/");
    expect(screen.getByRole("listbox", { name: "Insert a skill" })).toBeInTheDocument();
    expect(screen.getByText("/forge-code")).toBeInTheDocument();
    expect(screen.getByText("/dataviz")).toBeInTheDocument();
  });

  it("filters as the token is typed", () => {
    renderComposer();
    typeInto(textarea(), "/forge");
    expect(screen.getByText("/forge-code")).toBeInTheDocument();
    expect(screen.getByText("/forge-drive")).toBeInTheDocument();
    expect(screen.queryByText("/dataviz")).not.toBeInTheDocument();
  });

  it("stays closed for a slash that is part of prose", () => {
    renderComposer();
    typeInto(textarea(), "check docs/guides");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter inserts the highlighted skill instead of sending", async () => {
    const { onSend } = renderComposer();
    const el = textarea();
    typeInto(el, "/forge");
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(textarea().value).toBe("/forge-code "));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("arrow keys move the selection before Enter takes it", async () => {
    renderComposer();
    const el = textarea();
    typeInto(el, "/forge");
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(textarea().value).toBe("/forge-drive "));
  });

  it("ArrowUp from the first row wraps to the last match", async () => {
    renderComposer();
    const el = textarea();
    typeInto(el, "/forge");
    fireEvent.keyDown(el, { key: "ArrowUp" });
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(textarea().value).toBe("/forge-drive "));
  });

  it("clicking a row inserts it", async () => {
    renderComposer();
    typeInto(textarea(), "/data");
    fireEvent.mouseDown(screen.getByText("/dataviz"));
    await waitFor(() => expect(textarea().value).toBe("/dataviz "));
  });

  it("Escape closes the menu and keeps the typed text", () => {
    renderComposer();
    const el = textarea();
    typeInto(el, "/forge");
    fireEvent.keyDown(el, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea().value).toBe("/forge");
  });

  it("Enter still sends once the menu is closed — no regression to ISS-462's path", async () => {
    const { onSend } = renderComposer();
    const el = textarea();
    typeInto(el, "hello there");
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello there", []));
  });

  it("Shift+Enter never sends and never opens the menu", () => {
    const { onSend } = renderComposer();
    const el = textarea();
    typeInto(el, "/forge");
    fireEvent.keyDown(el, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe("/forge");
  });

  it("Enter sends the raw text when the token matches nothing", async () => {
    const { onSend } = renderComposer();
    const el = textarea();
    typeInto(el, "/nope");
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/nope", []));
  });

  it("says which query found nothing, distinctly from having no skills at all", () => {
    renderComposer();
    typeInto(textarea(), "/nope");
    expect(screen.getByText(/No skill matches/)).toBeInTheDocument();
    expect(screen.queryByText(/No skills are invokable/)).not.toBeInTheDocument();
  });

  it("shows a retry when the list failed to load", () => {
    const { retry } = renderComposer({ items: [], error: new Error("boom") });
    typeInto(textarea(), "/");
    expect(screen.getByText("Couldn't load skills.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });

  it("keeps the trigger while the list is loading, so the state is visible", () => {
    renderComposer({ items: [], loading: true });
    expect(screen.getByLabelText("Insert a skill")).toBeInTheDocument();
  });
});

describe("Composer — the trigger is never inert", () => {
  it("hides the trigger entirely when the project has no invokable skills", () => {
    renderComposer({ items: [] });
    expect(screen.queryByLabelText("Insert a skill")).not.toBeInTheDocument();
    // cm:why the second assertion is the one that matters — a hidden trigger is not enough if typing a slash can still open an empty panel
    typeInto(textarea(), "/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("hides the trigger when no skill source is wired at all (the run thread)", () => {
    renderComposer({ withSkills: false });
    expect(screen.queryByLabelText("Insert a skill")).not.toBeInTheDocument();
  });

  it("the trigger inserts a slash and opens the menu", async () => {
    renderComposer();
    fireEvent.click(screen.getByLabelText("Insert a skill"));
    await waitFor(() => expect(textarea().value).toBe("/"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("the trigger separates the slash from a preceding word", async () => {
    renderComposer();
    typeInto(textarea(), "run");
    fireEvent.click(screen.getByLabelText("Insert a skill"));
    await waitFor(() => expect(textarea().value).toBe("run /"));
  });
});

describe("Composer — the actions slot", () => {
  it("renders the injected controls inside the input row", () => {
    renderComposer({ actions: <button type="button">Sonnet</button> });
    expect(screen.getByRole("button", { name: "Sonnet" })).toBeInTheDocument();
  });

  it("renders nothing extra when no actions are passed (run-thread shape)", () => {
    renderComposer({ withSkills: false });
    expect(screen.getByLabelText("Attach files")).toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });
});
