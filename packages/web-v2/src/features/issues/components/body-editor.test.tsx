// @vitest-environment jsdom
//
// See what a body will look like before saving. The preview is the SERVER's
// answer, so the pane must show the kernel's own refusal rather than a generic
// failure line: that message names the element, the attribute and its legal
// set, and it is the only thing that tells an author what to change.
//
// The insert-component menu this file also covered was cut on 2026-09-14, and
// the case asserting it is gone is deliberate: it is the last one below.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
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
    mount("some prose");
    expect(preview).not.toHaveBeenCalled();
  });

  // cm:guard the composer offers NO way to insert component markup and reads the registry for nothing: the menu was the whole of ISS-967's authoring path and the owner cut it on 2026-09-14, so a re-added trigger is a decision to reverse rather than a control to restyle. The registry itself stays — the Pipeline settings tab's `requireComponent` select is its remaining caller.
  it("offers no component insert, and does not read the registry at all", () => {
    mount("some prose");

    expect(screen.queryByText(/insert/i)).toBeNull();
    expect(components).not.toHaveBeenCalled();
  });
});
