// @vitest-environment jsdom
//
// ISS-718 — the composer's `/` menu and inline actions slot, mounted for real.
// Matchers are extended on vitest's OWN `expect` (not the
// `@testing-library/jest-dom/vitest` convenience entry) because that entry
// resolves its own vitest peer, which under pnpm hoisting can land on a
// different vitest than the one running this file.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokableSkill } from "@/features/skills/types";
import { Composer } from "./composer";
import type { SlashSkillsSource } from "./slash-skills-menu";

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
    fetching?: boolean;
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
          fetching: over.fetching ?? false,
          retry,
        };
  const view = render(
    <Composer onSend={onSend} allowAttachments actions={over.actions} slashSkills={slashSkills} />,
  );
  /** Re-render with a settled source — how a retry's outcome actually arrives. */
  const settle = (next: Partial<SlashSkillsSource>) =>
    view.rerender(
      <Composer
        onSend={onSend}
        allowAttachments
        actions={over.actions}
        slashSkills={{ ...(slashSkills as SlashSkillsSource), ...next }}
      />,
    );
  return { ...view, onSend, retry, settle };
}

function textarea() {
  return screen.getByLabelText("Message") as HTMLTextAreaElement;
}

/** Type `text` the way a user would: value + caret, then fire `change`. */
function typeInto(el: HTMLTextAreaElement, text: string) {
  fireEvent.change(el, { target: { value: text, selectionStart: text.length } });
}

// cm:guard jsdom dispatches mousedown but performs NONE of its default actions, so a bare fireEvent.mouseDown never moves focus and never fires focusout. A press modelled without that step passes on code where the panel closes under the pointer and the click lands on nothing — which is exactly the defect this file failed to catch once already.
function pressWithFocusShift(el: HTMLElement) {
  act(() => {
    fireEvent.mouseDown(el);
    el.focus();
  });
  fireEvent.mouseUp(el);
  fireEvent.click(el);
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

  it("shows a retry when the list failed to load, and a real press reaches it", () => {
    const { retry } = renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    expect(screen.getByText("Couldn't load skills.")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Retry" });
    pressWithFocusShift(btn);
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("a press inside the panel that is not a row does not dismiss it", () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    pressWithFocusShift(screen.getByText("Skills"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("a press on a row still inserts even with the focus shift", async () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/data");
    pressWithFocusShift(screen.getByText("/dataviz"));
    await waitFor(() => expect(textarea().value).toBe("/dataviz "));
  });

  // cm:guard the relatedTarget guard above only covers browsers that move focus TO the pressed node. Safari clears focus to the body, where relatedTarget is null, so cancelling mousedown's default action is the half that covers it — and it is invisible to a test that only checks the panel survived, since either half alone passes in jsdom.
  it("cancels mousedown's focus default anywhere in the panel, which is what covers Safari", () => {
    renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    for (const node of [
      screen.getByText("Skills"),
      screen.getByRole("button", { name: "Retry" }),
    ]) {
      const ev = createEvent.mouseDown(node);
      fireEvent(node, ev);
      expect(ev.defaultPrevented).toBe(true);
    }
  });

  it("cancels the focus default on a skill row too", () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/data");
    const row = screen.getByText("/dataviz");
    const ev = createEvent.mouseDown(row);
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Tab reaches the error state's Retry, so it is not mouse-only", () => {
    const { retry } = renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    const btn = screen.getByRole("button", { name: "Retry" });
    fireEvent.keyDown(el, { key: "Tab" });
    // cm:why both assertions are needed — the panel surviving the focus move is the half the round-2 bug broke, and the button holding focus is the half that makes Retry reachable at all
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(retry).toHaveBeenCalled();
  });

  it("Escape from inside the panel closes it and hands focus back", () => {
    renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    fireEvent.keyDown(el, { key: "Tab" });
    const btn = screen.getByRole("button", { name: "Retry" });
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(textarea());
    typeInto(textarea(), "/more");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Tab is left alone when there is no error to retry", () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/forge");
    fireEvent.keyDown(el, { key: "Tab" });
    expect(document.activeElement).toBe(el);
  });

  it("Escape stays dismissed while the same token is still being typed", () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/for");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(el, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // cm:why continuing to type inside the DISMISSED token is the case that used to resurrect the panel, costing an Escape per keystroke
    typeInto(el, "/forg");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    typeInto(el, "/forge");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("a NEW token after a dismissal opens the menu again", () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/for");
    fireEvent.keyDown(el, { key: "Escape" });
    typeInto(el, "/for and now /data");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("/dataviz")).toBeInTheDocument();
  });

  it("the trigger reopens a dismissed token on demand", async () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/for");
    fireEvent.keyDown(el, { key: "Escape" });
    fireEvent.click(screen.getByLabelText("Insert a skill"));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  });

  it("a keyboard Retry that SUCCEEDS does not strand focus on the body", () => {
    const { retry, settle } = renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    fireEvent.keyDown(el, { key: "Tab" });
    const btn = screen.getByRole("button", { name: "Retry" });
    expect(document.activeElement).toBe(btn);
    // cm:guard focus must leave the button BEFORE the retry can unmount it. React fires no blur for a node removed while focused, so a fix that only handled blur would leave activeElement on <body> with the panel still up and its keys — which live on the textarea — unreachable.
    fireEvent.click(btn);
    expect(document.activeElement).toBe(textarea());
    act(() => settle({ items: SKILLS, error: null }));
    expect(retry).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(textarea());
    // cm:why the last two assertions are the point — a stranded focus leaves the panel mounted and its keys, which live on the textarea, unreachable, so proving Escape still works is what proves focus came home
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("focus leaving the panel for outside the composer dismisses it", () => {
    renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    fireEvent.keyDown(el, { key: "Tab" });
    const btn = screen.getByRole("button", { name: "Retry" });
    const send = screen.getByLabelText("Send message");
    act(() => {
      fireEvent.blur(btn, { relatedTarget: send });
      send.focus();
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("focus returning to the textarea keeps the panel up", () => {
    renderComposer({ items: [], error: new Error("boom") });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    fireEvent.keyDown(el, { key: "Tab" });
    const btn = screen.getByRole("button", { name: "Retry" });
    fireEvent.blur(btn, { relatedTarget: textarea() });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Retry says it is retrying while the fetch is in flight", () => {
    renderComposer({ items: [], error: new Error("boom"), fetching: true });
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    const btn = screen.getByRole("button", { name: /Retrying/ });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("a press outside both the row and the panel dismisses it", () => {
    renderComposer();
    typeInto(textarea(), "/");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("leaving the textarea for something outside the panel still dismisses it", () => {
    renderComposer();
    const el = textarea();
    act(() => el.focus());
    typeInto(el, "/");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.blur(el, { relatedTarget: document.body });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
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
