// @vitest-environment jsdom
//
// ISS-967 outcome 3 — insert a component without typing markup, and see what it
// will look like before saving. The preview is the SERVER's answer, so the pane
// must show the kernel's own refusal rather than a generic failure line: that
// message names the element, the attribute and its legal set, and it is the
// only thing that tells an author what to change.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { BodyEditor } from "./body-editor";

expect.extend(matchers);

const components = vi.fn();
const preview = vi.fn();

vi.mock("../body-api", async () => {
  const actual = await vi.importActual<typeof import("../body-api")>("../body-api");
  return {
    ...actual,
    bodyApi: {
      components: () => components(),
      preview: (raw: string) => preview(raw),
    },
  };
});

vi.mock("@/design/patterns/body-view", () => ({
  BodyView: ({ body }: { body: string }) => <div data-testid="rendered">{body}</div>,
}));

const SPEC = {
  name: "forge-blocked",
  root: true,
  leaf: false,
  raw: false,
  ordered: false,
  attrs: [{ name: "on", required: true, values: ["decision", "resource", "person"] }],
  slots: [],
};

function mount(value: string, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BodyEditor label="Body" value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

afterEach(() => {
  cleanup();
  components.mockReset();
  preview.mockReset();
});

describe("BodyEditor", () => {
  it("offers the registry's roots and inserts a skeleton for the one chosen", async () => {
    components.mockResolvedValue([SPEC, { ...SPEC, name: "forge-summary", root: false }]);
    const onChange = mount("");

    fireEvent.click(screen.getByText("Insert component"));
    await waitFor(() => expect(screen.getByText("forge-blocked")).toBeInTheDocument());
    expect(screen.queryByText("forge-summary")).toBeNull();

    fireEvent.click(screen.getByText("forge-blocked"));
    expect(onChange).toHaveBeenCalledWith('<forge-blocked on="decision">\n\n</forge-blocked>');
  });

  it("shows the kernel's own refusal, not a generic failure line", async () => {
    components.mockResolvedValue([]);
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
    components.mockResolvedValue([]);
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
    components.mockResolvedValue([]);
    mount("some prose");
    expect(preview).not.toHaveBeenCalled();
  });
});
