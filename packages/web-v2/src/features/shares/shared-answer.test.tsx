import type { ShareSnapshot } from "@forge/contracts/shares";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { SharedAnswer, SharedAnswerView } from "./components/shared-answer";

// The page a share link opens draws the frozen answer as text and nothing else: no link into the
// project, no markup parsed, an unknown block named rather than dropped, and the token sent only in
// a request body.

const TOKEN = `forge_share_${"x".repeat(43)}`;

function snapshot(audience: "members" | "link" = "link"): ShareSnapshot {
  const frame = {
    fields: [
      { name: "requirement", type: "ref" as const, label: "Requirement" },
      { name: "note", type: "string" as const, label: "Note" },
      { name: "proven", type: "number" as const, label: "Proven" },
    ],
    rows: [{ requirement: "REQ-7", note: "[click](https://evil.example) <b>bold</b>", proven: 5 }],
  };
  return {
    audience,
    expiresAt: "2026-10-15T09:00:00.000Z",
    document: {
      templateId: "progress",
      version: 1,
      params: {},
      runs: [
        {
          runId: "run-1",
          queryId: "progress-by-requirement",
          version: 1,
          params: {},
          projectId: "p1",
          actor: { kind: "human", id: "u1" },
          asOf: "2026-10-08T09:00:00.000Z",
          frame,
        },
      ],
      blocks: [
        { kind: "table", v: 1, title: "Progress", columns: ["requirement", "note", "proven"], source: { runId: "run-1" }, frame },
      ],
      narrative: { summary: "One requirement moved.", risks: "", recommendations: "Prove REQ-7." },
    },
  };
}

describe("a shared answer", () => {
  it("draws each block as text with its source, and links nowhere", () => {
    const { container } = renderWithQuery(<SharedAnswerView snapshot={snapshot()} />);
    expect(screen.getByText("Report: progress")).toBeInTheDocument();
    expect(screen.getByText("One requirement moved.")).toBeInTheDocument();
    expect(screen.queryByText("Risks")).toBeNull();
    const table = container.querySelector("pre")?.textContent ?? "";
    expect(table).toContain("REQ-7");
    expect(table).toContain("5");
    expect(table).toContain("<b>bold</b>");
    expect(screen.getByText(/From the progress-by-requirement report, read/)).toBeInTheDocument();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("b")).toHaveLength(0);
  });

  it("names a block whose kind this build cannot show, rather than dropping it", () => {
    const s = snapshot();
    s.document.blocks = [{ kind: "pie" } as never];
    renderWithQuery(<SharedAnswerView snapshot={s} />);
    expect(screen.getByText("This answer has a pie block this page cannot show.")).toBeInTheDocument();
  });

  it("opens through the open door with the token in the body, and waits for the session first", async () => {
    const calls = fakeCore((call) =>
      call.path === "/shares/open" ? { body: snapshot() } : undefined,
    );
    const { client, rerender } = renderWithQuery(<SharedAnswer token={TOKEN} signedIn={null} />);
    expect(calls).toHaveLength(0);
    rerender(
      <QueryClientProvider client={client}>
        <SharedAnswer token={TOKEN} signedIn={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Report: progress")).toBeInTheDocument();
    expect(calls).toEqual([{ method: "POST", path: "/shares/open", body: { token: TOKEN } }]);
  });

  it("opens through the member door for a signed-in reader", async () => {
    const calls = fakeCore((call) =>
      call.path === "/shares/open/member" ? { body: snapshot("members") } : undefined,
    );
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn />);
    expect(await screen.findByText("Shared with the project's members", { exact: false })).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(["/shares/open/member"]);
  });

  it("says plainly when a link is no longer available", async () => {
    fakeCore(() => ({
      status: 404,
      body: { code: "SHARE_NOT_AVAILABLE", message: "not available", error: { code: "SHARE_NOT_AVAILABLE", message: "not available", refusals: [] } },
    }));
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This link is not available.");
  });
});
