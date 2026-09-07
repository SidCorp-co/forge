// @vitest-environment jsdom
//
// ISS-950 — the three states this tab can be in that a screenshot of the happy one never shows,
// and the one distinction the design contract turns on: a REFUSAL is not a failure. `NO_MODULES`
// tells the reader to go and create a module; a 500 tells them to retry. Merged into one
// "couldn't load" box, whichever reader is wrong has no way to find that out.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { DiagramsTab } from "./components/diagrams-tab";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("@/design/patterns/mermaid", () => ({
  MermaidDiagram: ({ code }: { code: string }) => <pre data-testid="mermaid">{code}</pre>,
}));

let answer: () => Promise<unknown> = async () => ({});

vi.mock("./api", () => ({
  knowledgeApi: { getModuleDiagram: () => answer() },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DiagramsTab projectId="p1" />
    </QueryClientProvider>,
  );
}

describe("DiagramsTab", () => {
  it("shows a skeleton while the diagram is being generated", () => {
    answer = () => new Promise(() => {});
    const { container } = mount();
    expect(container.querySelector(".skeleton")).not.toBeNull();
  });

  it("renders the generated mermaid it was given", async () => {
    answer = async () => ({
      kind: "mindmap",
      mermaid: "mindmap\n  root((Forge))",
      moduleCount: 3,
      generatedAt: "2026-09-07T00:00:00Z",
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("mermaid")).toHaveTextContent("root((Forge))"));
    expect(screen.getByText(/3 modules/)).toBeInTheDocument();
  });

  it("states a refusal in words rather than offering a retry that would refuse again", async () => {
    answer = async () => {
      throw new ApiError(409, "no modules", "NO_MODULES");
    };
    mount();
    await waitFor(() => expect(screen.getByText(/Nothing to draw yet/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("offers a retry when the request actually failed", async () => {
    answer = async () => {
      throw new ApiError(500, "boom");
    };
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Couldn’t load the diagram/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
