// @vitest-environment jsdom
//
// What this file can and cannot claim.
//
// CAN: the toolbar exists, every button is a real labelled control, a press
// reaches the editor as one transaction carrying both the change and the
// caret, the shortcut needs its modifier, and the preview pane shows the
// SERVER's answer — which carries the kernel's own refusal naming the element,
// the attribute and its legal set.
//
// CANNOT: that CodeMirror honours the transaction. The editor is the stand-in
// from `@/test/codemirror-stub`, which carries why a real one cannot mount
// here. Every claim about the text an action produces is in
// `markdown-actions.test.ts`, against the pure functions this wires up.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { type FakeView, lastView } from "@/test/codemirror-stub";
import { BodyEditor } from "./body-editor";

expect.extend(matchers);

const components = vi.fn();
const preview = vi.fn();

vi.mock("../body-api", () => ({
  bodyApi: {
    components: () => components(),
    preview: (raw: string) => preview(raw),
  },
}));

vi.mock("@/design/patterns/body-view", () => ({
  BodyView: ({ body }: { body: string }) => <div data-testid="rendered">{body}</div>,
}));

vi.mock("@uiw/react-codemirror", async () => (await import("@/test/codemirror-stub")).codeMirrorStub());

function mount(value = "", onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BodyEditor label="Comment" value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  if (!lastView) throw new Error("the editor did not mount — every case below drives it");
  return { onChange, view: lastView, content: lastView.dom };
}

/** Put the caret/selection where a person would have left it before pressing. */
function select(view: FakeView, from: number, to: number) {
  view.sel = { from, to };
}

afterEach(() => {
  cleanup();
  components.mockReset();
  preview.mockReset();
});

describe("the formatting toolbar", () => {
  it("offers every tool as a named control", () => {
    mount();
    for (const name of [
      /^Bold/,
      /^Italic/,
      /^Inline code/,
      /^Link/,
      /^Heading/,
      /^Quote/,
      /^Bulleted list/,
      /^Numbered list/,
      /^Code block/,
      /^Mermaid diagram/,
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("names the shortcut on the controls that carry one", () => {
    mount();
    expect(screen.getByRole("button", { name: "Bold (Ctrl+B)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link (Ctrl+K)" })).toBeInTheDocument();
  });

  it("formats what is selected and reports the new document", () => {
    const { onChange, view } = mount("make it loud");
    select(view, 8, 12);
    fireEvent.mouseDown(screen.getByRole("button", { name: /^Bold/ }));

    expect(view.state.doc.toString()).toBe("make it **loud**");
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("make it **loud**");
  });

  it("leaves the selection on the text, not on the markers", () => {
    const { view } = mount("make it loud");
    select(view, 8, 12);
    fireEvent.mouseDown(screen.getByRole("button", { name: /^Bold/ }));

    const { from, to } = view.state.selection.main;
    expect(view.state.doc.toString().slice(from, to)).toBe("loud");
  });

  it("acts on mousedown, so the selection still exists when it runs", () => {
    const { view } = mount("make it loud");
    select(view, 8, 12);
    const notCancelled = fireEvent.mouseDown(screen.getByRole("button", { name: /^Bold/ }));

    expect(notCancelled).toBe(false);
    expect(view.state.doc.toString()).toBe("make it **loud**");
    expect(view.focused).toBeGreaterThan(0);
  });

  it("runs the same action from the keyboard", () => {
    const { view, content } = mount("make it loud");
    select(view, 8, 12);
    fireEvent.keyDown(content, { key: "b", ctrlKey: true });

    expect(view.state.doc.toString()).toBe("make it **loud**");
  });

  it("leaves a modified key it does not own to the editor", () => {
    const { view, content } = mount("make it loud");
    select(view, 8, 12);
    fireEvent.keyDown(content, { key: "z", ctrlKey: true });

    expect(view.state.doc.toString()).toBe("make it loud");
  });

  it("does not fire on the bare letter, only with ctrl or meta", () => {
    const { view, content } = mount("make it loud");
    select(view, 8, 12);
    fireEvent.keyDown(content, { key: "b" });

    expect(view.state.doc.toString()).toBe("make it loud");
  });

  it("fires on meta for the same key, so it works on a mac", () => {
    const { view, content } = mount("make it loud");
    select(view, 8, 12);
    fireEvent.keyDown(content, { key: "b", metaKey: true });

    expect(view.state.doc.toString()).toBe("make it **loud**");
  });
});

describe("the preview pane", () => {
  it("shows the kernel's own refusal, not a generic failure line", async () => {
    preview.mockRejectedValue(
      new ApiError(
        400,
        "`forge-review@verdict`: Invalid option — legal values: approve|request-changes|abstain",
        "BODY_INVALID",
      ),
    );
    mount('<forge-review sha="60e8d635" verdict="maybe"></forge-review>');

    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await waitFor(() =>
      expect(screen.getByText(/approve\|request-changes\|abstain/)).toBeInTheDocument(),
    );
  });

  it("draws the bytes the server would store, not the bytes that were typed", async () => {
    preview.mockResolvedValue({
      body: "<p>typed loosely</p>",
      format: "html",
      template: null,
      warnings: [],
      text: "typed loosely",
      nodes: [],
    });
    mount("typed loosely");

    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await waitFor(() =>
      expect(screen.getByTestId("rendered")).toHaveTextContent("<p>typed loosely</p>"),
    );
  });

  it("asks the server for nothing until the pane is opened", () => {
    mount("some prose");
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("the component insert that was removed", () => {
  it("offers no component insert, and does not read the registry at all", () => {
    mount("some prose");
    expect(screen.queryByText(/insert/i)).toBeNull();
    expect(components).not.toHaveBeenCalled();
  });
});
